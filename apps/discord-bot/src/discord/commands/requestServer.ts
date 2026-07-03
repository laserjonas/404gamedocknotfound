import {
  ActionRowBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
} from 'discord.js';
import type { GameTemplateDto, InstanceDto } from '@gamedock/shared';
import type { GameDockClient } from '../../gamedockClient.js';
import type { RoleQuotaRepository } from '../../db/repositories/roleQuotas.js';
import type { RequestRepository } from '../../db/repositories/requests.js';
import { quotaAllowsTemplate, resolveQuota } from '../../quota.js';
import type { EffectiveQuota } from '../../quota.js';
import { deriveInstanceName } from '../../instanceName.js';

export interface CommandDeps {
  gamedock: GameDockClient;
  roleQuotas: RoleQuotaRepository;
  requests: RequestRepository;
}

export const data = new SlashCommandBuilder()
  .setName('request-server')
  .setDescription('Request a game server for yourself, limited by your Discord role')
  .addStringOption((option) =>
    option
      .setName('game')
      .setDescription('Which game to request')
      .setRequired(true)
      .setAutocomplete(true),
  );

const JOB_POLL_INTERVAL_MS = 3000;
const JOB_POLL_TIMEOUT_MS = 10 * 60 * 1000; // installs can take a while (Steam downloads)

export const MODAL_CUSTOM_ID_PREFIX = 'request-server:';
/** Discord modals support at most 5 components. */
const MAX_MODAL_FIELDS = 5;

type RepliableInteraction = ChatInputCommandInteraction | ModalSubmitInteraction;

/** Roles are fetched fresh rather than read off interaction.member, which
 * can be either a full GuildMember or a raw partial object depending on
 * client caching - fetching sidesteps that ambiguity entirely. */
async function getMemberRoleIds(
  interaction: ChatInputCommandInteraction | AutocompleteInteraction | ModalSubmitInteraction,
): Promise<string[]> {
  if (!interaction.guild) return [];
  const member = await interaction.guild.members.fetch(interaction.user.id);
  return [...member.roles.cache.values()].map((role) => role.id);
}

/** The required template variables shown in the request modal, capped at
 * Discord's 5-component limit - anything beyond that still just uses the
 * template's own default, same as before this variable-collection existed. */
export function modalFieldsFor(template: Pick<GameTemplateDto, 'variables'>) {
  return template.variables.filter((v) => v.required).slice(0, MAX_MODAL_FIELDS);
}

type Eligibility = { ok: true; quota: EffectiveQuota } | { ok: false; message: string };

/** Shared by the initial slash command and the modal submission - re-checked
 * at submit time too, since a member's roles or active-request count can
 * change while they have the form open. */
async function checkEligibility(
  interaction: RepliableInteraction,
  deps: CommandDeps,
): Promise<Eligibility> {
  const roleIds = await getMemberRoleIds(interaction);
  const quota = resolveQuota(deps.roleQuotas.findForRoleIds(roleIds));
  if (!quota) {
    return {
      ok: false,
      message: "You don't have a Discord role that's set up to request a server. Ask an admin.",
    };
  }
  const currentCount = deps.requests.countActiveForUser(interaction.user.id);
  if (currentCount >= quota.maxServers) {
    return { ok: false, message: `You're already at your limit of ${quota.maxServers} server(s).` };
  }
  return { ok: true, quota };
}

export async function autocomplete(
  interaction: AutocompleteInteraction,
  deps: CommandDeps,
): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  const roleIds = await getMemberRoleIds(interaction);
  const quota = resolveQuota(deps.roleQuotas.findForRoleIds(roleIds));

  if (!quota) {
    await interaction.respond([]);
    return;
  }

  let templates;
  try {
    templates = await deps.gamedock.listTemplates();
  } catch {
    await interaction.respond([]);
    return;
  }

  const matches = templates
    .filter((t) => quotaAllowsTemplate(quota, t.id))
    .filter((t) => t.name.toLowerCase().includes(focused) || t.id.toLowerCase().includes(focused))
    .slice(0, 25) // Discord caps autocomplete choices at 25
    .map((t) => ({ name: t.name, value: t.id }));

  await interaction.respond(matches);
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  const templateId = interaction.options.getString('game', true);

  const eligibility = await checkEligibility(interaction, deps);
  if (!eligibility.ok) {
    await interaction.reply({ content: eligibility.message, ephemeral: true });
    return;
  }
  if (!quotaAllowsTemplate(eligibility.quota, templateId)) {
    await interaction.reply({
      content: `Your role (${eligibility.quota.matchedRoleLabels.join(', ')}) isn't allowed to request that game.`,
      ephemeral: true,
    });
    return;
  }

  let templates: GameTemplateDto[];
  try {
    templates = await deps.gamedock.listTemplates();
  } catch (err) {
    await interaction.reply({
      content: `Couldn't reach GameDock: ${(err as Error).message}`,
      ephemeral: true,
    });
    return;
  }
  const template = templates.find((t) => t.id === templateId);
  if (!template) {
    await interaction.reply({
      content: 'Unknown game - try again from the autocomplete list.',
      ephemeral: true,
    });
    return;
  }

  const fields = modalFieldsFor(template);
  if (fields.length === 0) {
    // Nothing to ask - go straight to creation, same as before request modals existed.
    await interaction.deferReply({ ephemeral: true });
    await createAndInstall(interaction, deps, template, {});
    return;
  }

  // showModal() must be the interaction's first response - can't defer first.
  const modal = new ModalBuilder()
    .setCustomId(`${MODAL_CUSTOM_ID_PREFIX}${template.id}`)
    .setTitle(`Request: ${template.name}`.slice(0, 45));
  for (const variable of fields) {
    const input = new TextInputBuilder()
      .setCustomId(variable.key)
      .setLabel(variable.label.slice(0, 45))
      .setStyle(TextInputStyle.Short)
      .setValue(variable.default)
      .setRequired(true);
    if (variable.description) {
      input.setPlaceholder(variable.description.slice(0, 100));
    }
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }
  await interaction.showModal(modal);
}

export async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
  deps: CommandDeps,
): Promise<void> {
  if (!interaction.customId.startsWith(MODAL_CUSTOM_ID_PREFIX)) return;
  const templateId = interaction.customId.slice(MODAL_CUSTOM_ID_PREFIX.length);

  await interaction.deferReply({ ephemeral: true });

  const eligibility = await checkEligibility(interaction, deps);
  if (!eligibility.ok) {
    await interaction.editReply(eligibility.message);
    return;
  }
  if (!quotaAllowsTemplate(eligibility.quota, templateId)) {
    await interaction.editReply(
      `Your role (${eligibility.quota.matchedRoleLabels.join(', ')}) isn't allowed to request that game.`,
    );
    return;
  }

  let templates: GameTemplateDto[];
  try {
    templates = await deps.gamedock.listTemplates();
  } catch (err) {
    await interaction.editReply(`Couldn't reach GameDock: ${(err as Error).message}`);
    return;
  }
  const template = templates.find((t) => t.id === templateId);
  if (!template) {
    await interaction.editReply('That game is no longer available - run /request-server again.');
    return;
  }

  const variables: Record<string, string> = {};
  for (const variable of modalFieldsFor(template)) {
    variables[variable.key] = interaction.fields.getTextInputValue(variable.key);
  }

  await createAndInstall(interaction, deps, template, variables);
}

async function createAndInstall(
  interaction: RepliableInteraction,
  deps: CommandDeps,
  template: GameTemplateDto,
  variables: Record<string, string>,
): Promise<void> {
  const name = deriveInstanceName(interaction.user.id, template.id);

  let instance: InstanceDto;
  try {
    instance = await deps.gamedock.createInstance({ name, templateId: template.id, variables });
  } catch (err) {
    await interaction.editReply(`Couldn't create the server: ${(err as Error).message}`);
    return;
  }

  const request = deps.requests.create({
    discordUserId: interaction.user.id,
    discordGuildId: interaction.guildId ?? '',
    instanceId: instance.id,
    instanceName: instance.name,
    templateId: template.id,
    status: 'provisioning',
  });

  await interaction.editReply(
    `Creating **${template.name}** server \`${instance.name}\`, starting the install now...`,
  );

  let job;
  try {
    ({ job } = await deps.gamedock.enqueueInstall(instance.id));
  } catch (err) {
    deps.requests.updateStatus(request.id, 'failed');
    await interaction.editReply(
      `Server created but the install failed to start: ${(err as Error).message}`,
    );
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < JOB_POLL_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
    let current;
    try {
      current = await deps.gamedock.getJob(job.id);
    } catch {
      continue; // transient - keep polling until the overall timeout
    }
    if (current.status === 'succeeded') {
      await finishInstall(interaction, deps, template, instance, request.id);
      return;
    }
    if (current.status === 'failed' || current.status === 'canceled') {
      deps.requests.updateStatus(request.id, 'failed');
      await interaction.editReply(
        `Install ${current.status === 'canceled' ? 'was canceled' : 'failed'}: ${current.message ?? 'no details'}`,
      );
      return;
    }
    await interaction.editReply(
      `Installing **${template.name}** server \`${instance.name}\`...` +
        (current.progress !== null ? ` ${Math.round(current.progress)}%` : ''),
    );
  }

  // Not necessarily failed - just stop polling after the timeout and point at the panel.
  await interaction.editReply(
    `Still installing **${template.name}** server \`${instance.name}\` - this is taking a while, check the GameDock panel for status.`,
  );
}

/** Starts the server once installed, so a Discord request results in a
 * running server, not just downloaded files someone has to start manually. */
async function finishInstall(
  interaction: RepliableInteraction,
  deps: CommandDeps,
  template: GameTemplateDto,
  instance: InstanceDto,
  requestId: string,
): Promise<void> {
  deps.requests.updateStatus(requestId, 'active');
  const portList = instance.ports.map((p) => `${p.name} ${p.port}/${p.protocol}`).join(', ');

  try {
    await deps.gamedock.startInstance(instance.id);
  } catch (err) {
    await interaction.editReply(
      `**${template.name}** server \`${instance.name}\` is installed but failed to start automatically ` +
        `(${(err as Error).message}) - start it from the GameDock panel.`,
    );
    return;
  }

  await interaction.editReply(
    `**${template.name}** server \`${instance.name}\` is installed and starting up now!` +
      (portList ? ` Port(s): ${portList}.` : '') +
      ' Give it a moment to come online.',
  );
}
