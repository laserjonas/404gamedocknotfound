import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { RoleQuotaRepository } from '../../db/repositories/roleQuotas.js';
import { ALL_GAMES_SENTINEL } from '../../quota.js';

export interface ConfigCommandDeps {
  roleQuotas: RoleQuotaRepository;
}

export const data = new SlashCommandBuilder()
  .setName('gamedock-config')
  .setDescription('Configure which Discord roles can request GameDock servers, and how many')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('set-role-limit')
      .setDescription('Set (or update) the server quota for a Discord role')
      .addRoleOption((option) =>
        option.setName('role').setDescription('The Discord role to configure').setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName('max-servers')
          .setDescription('Maximum active servers a member with this role may request')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(100),
      )
      .addStringOption((option) =>
        option
          .setName('games')
          .setDescription(
            'Comma-separated GameDock template ids, e.g. valheim,minecraft-java - or "all" for every game',
          )
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove-role-limit')
      .setDescription("Remove a Discord role's server-request quota entirely")
      .addRoleOption((option) =>
        option.setName('role').setDescription('The Discord role to remove').setRequired(true),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List all configured role quotas'));

/**
 * All three subcommands require Manage Server - checked explicitly here
 * (not just via setDefaultMemberPermissions above, which only sets the
 * *default* and can be overridden per-guild in Discord's own UI), so a
 * server that's loosened the default can't bypass this.
 */
function hasManageGuild(interaction: ChatInputCommandInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  deps: ConfigCommandDeps,
): Promise<void> {
  if (!hasManageGuild(interaction)) {
    await interaction.reply({
      content: 'You need the "Manage Server" permission to use this command.',
      ephemeral: true,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'set-role-limit') {
    const role = interaction.options.getRole('role', true);
    const maxServers = interaction.options.getInteger('max-servers', true);
    const rawGames = interaction.options
      .getString('games', true)
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean);

    if (rawGames.length === 0) {
      await interaction.reply({ content: 'List at least one game template id.', ephemeral: true });
      return;
    }

    const allowsAll = rawGames.some((g) => g.toLowerCase() === 'all');
    const games = allowsAll ? [ALL_GAMES_SENTINEL] : rawGames;

    deps.roleQuotas.upsert({
      discordRoleId: role.id,
      label: role.name,
      maxServers,
      allowedTemplateIds: games,
    });
    await interaction.reply({
      content: `Set **${role.name}**'s quota: up to ${maxServers} server(s), games: ${allowsAll ? 'all' : games.join(', ')}.`,
      ephemeral: true,
    });
    return;
  }

  if (sub === 'remove-role-limit') {
    const role = interaction.options.getRole('role', true);
    const { changes } = deps.roleQuotas.remove(role.id);
    await interaction.reply({
      content:
        changes > 0
          ? `Removed **${role.name}**'s server-request quota.`
          : `**${role.name}** didn't have a quota configured.`,
      ephemeral: true,
    });
    return;
  }

  // sub === 'list'
  const rows = deps.roleQuotas.list();
  if (rows.length === 0) {
    await interaction.reply({ content: 'No role quotas configured yet.', ephemeral: true });
    return;
  }
  const lines = rows.map((row) => {
    const templateIds = JSON.parse(row.allowed_template_ids) as string[];
    const games = templateIds.includes(ALL_GAMES_SENTINEL) ? 'all' : templateIds.join(', ');
    return `**${row.label}** — up to ${row.max_servers} server(s), games: ${games}`;
  });
  await interaction.reply({ content: lines.join('\n'), ephemeral: true });
}
