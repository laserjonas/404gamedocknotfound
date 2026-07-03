import { Client, Events, GatewayIntentBits, REST, Routes } from 'discord.js';
import type { BotConfig } from '../config.js';
import type { GameDockClient } from '../gamedockClient.js';
import type { RoleQuotaRepository } from '../db/repositories/roleQuotas.js';
import type { RequestRepository } from '../db/repositories/requests.js';
import * as requestServerCommand from './commands/requestServer.js';
import * as configCommand from './commands/config.js';

export interface BotDeps {
  gamedock: GameDockClient;
  roleQuotas: RoleQuotaRepository;
  requests: RequestRepository;
}

export async function startBot(
  config: BotConfig,
  deps: BotDeps,
  log: (msg: string) => void,
): Promise<Client> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const rest = new REST().setToken(config.discordBotToken);

  client.once(Events.ClientReady, (readyClient) => {
    log(`Logged in as ${readyClient.user.tag}`);
    rest
      .put(Routes.applicationGuildCommands(readyClient.user.id, config.discordGuildId), {
        body: [requestServerCommand.data.toJSON(), configCommand.data.toJSON()],
      })
      .then(() => log('Slash commands registered'))
      .catch((err: Error) => log(`Failed to register slash commands: ${err.message}`));
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'request-server') {
          await requestServerCommand.autocomplete(interaction, deps);
        }
        return;
      }
      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith(requestServerCommand.MODAL_CUSTOM_ID_PREFIX)) {
          await requestServerCommand.handleModalSubmit(interaction, deps);
        }
        return;
      }
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'request-server') {
          await requestServerCommand.execute(interaction, deps);
        } else if (interaction.commandName === 'gamedock-config') {
          await configCommand.execute(interaction, deps);
        }
      }
    } catch (err) {
      log(`Interaction handler error: ${(err as Error).message}`);
      if (!interaction.isRepliable()) return;
      try {
        const content = 'Something went wrong handling that command.';
        if (interaction.deferred) {
          await interaction.editReply(content);
        } else if (!interaction.replied) {
          await interaction.reply({ content, ephemeral: true });
        }
      } catch {
        // best-effort - the interaction may have already expired
      }
    }
  });

  await client.login(config.discordBotToken);
  return client;
}
