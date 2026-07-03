import { SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import type { GameDockClient } from '../../gamedockClient.js';
import type { RoleQuotaRepository } from '../../db/repositories/roleQuotas.js';
import type { RequestRepository } from '../../db/repositories/requests.js';
import { quotaAllowsTemplate, resolveQuota } from '../../quota.js';
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

/** Roles are fetched fresh rather than read off interaction.member, which
 * can be either a full GuildMember or a raw partial object depending on
 * client caching - fetching sidesteps that ambiguity entirely. */
async function getMemberRoleIds(
  interaction: ChatInputCommandInteraction | AutocompleteInteraction,
): Promise<string[]> {
  if (!interaction.guild) return [];
  const member = await interaction.guild.members.fetch(interaction.user.id);
  return [...member.roles.cache.values()].map((role) => role.id);
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
  await interaction.deferReply({ ephemeral: true });

  const templateId = interaction.options.getString('game', true);
  const roleIds = await getMemberRoleIds(interaction);
  const quota = resolveQuota(deps.roleQuotas.findForRoleIds(roleIds));

  if (!quota) {
    await interaction.editReply(
      "You don't have a Discord role that's set up to request a server. Ask an admin.",
    );
    return;
  }
  if (!quotaAllowsTemplate(quota, templateId)) {
    await interaction.editReply(
      `Your role (${quota.matchedRoleLabels.join(', ')}) isn't allowed to request that game.`,
    );
    return;
  }

  const currentCount = deps.requests.countActiveForUser(interaction.user.id);
  if (currentCount >= quota.maxServers) {
    await interaction.editReply(`You're already at your limit of ${quota.maxServers} server(s).`);
    return;
  }

  let templates;
  try {
    templates = await deps.gamedock.listTemplates();
  } catch (err) {
    await interaction.editReply(`Couldn't reach GameDock: ${(err as Error).message}`);
    return;
  }
  const template = templates.find((t) => t.id === templateId);
  if (!template) {
    await interaction.editReply('Unknown game - try again from the autocomplete list.');
    return;
  }

  const name = deriveInstanceName(interaction.user.id, templateId);

  let instance;
  try {
    instance = await deps.gamedock.createInstance({ name, templateId });
  } catch (err) {
    await interaction.editReply(`Couldn't create the server: ${(err as Error).message}`);
    return;
  }

  const request = deps.requests.create({
    discordUserId: interaction.user.id,
    discordGuildId: interaction.guildId ?? '',
    instanceId: instance.id,
    instanceName: instance.name,
    templateId,
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
      deps.requests.updateStatus(request.id, 'active');
      await interaction.editReply(
        `**${template.name}** server \`${instance.name}\` is installed and ready - start/manage it from the GameDock panel.`,
      );
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
