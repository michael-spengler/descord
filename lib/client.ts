import { green, red, yellow } from 'https://deno.land/std/fmt/colors.ts';
import { HTTPError } from './errors/error.ts';
import { Collection, HTTPClient } from './utils/util.ts';
import { ClientUser, Shard } from './models/model.ts';
import { Presence } from './interfaces/interface.ts';

/**
 * The discord API Wrapper client that lets you interact with the API.
 */
class Client {
  #eventHandler: Map<string, (...params: any[]) => void>;
  readonly httpBase: string;
  #wsBase: string;
  #token?: string;
  readonly guilds: Collection<string, any>;
  readonly channels: Collection<string, any>;
  readonly messages: Collection<string, any>;
  readonly users: Collection<string, any>;
  #user?: ClientUser;
  #clientId?: string;
  #shardCount: number;
  #ready: boolean;

  shardManager: Collection<number, Shard>;
  owners: string[];
  http: HTTPClient;

  /**
   * Create a new descord client.
   */
  constructor() {
    this.#eventHandler = new Map();
    this.httpBase = 'https://discord.com/api/v6';
    this.#wsBase = '';
    this.#shardCount = 1;
    this.guilds = new Collection();
    this.channels = new Collection();
    this.messages = new Collection();
    this.users = new Collection();
    this.#ready = false;

    this.shardManager = new Collection();
    this.owners = [];
    this.http = new HTTPClient(this, { apiVersion: 6 });
  }

  /**
   * Set a new event handler for a specific event of the descord client.
   * @param event The event that needs to be handled.
   * @param handler The callback function which is called when the event is fired.
   */
  addEventListener(event: string, handler: (...params: any[]) => void) {
    if (this.#eventHandler.get(event))
      throw `Event handler already set for event: ${event}. Only one handler per event is allowed`;
    else this.#eventHandler.set(event, handler);
  }

  /**
   * Set a new event handler for a specific event of the descord client.
   * @param event The event that needs to be handled.
   * @param handler The callback function which is called when the event is fired.
   */
  on(event: string, handler: (...params: any[]) => void) {
    this.addEventListener(event, handler);
  }

  /**
   * The discord bot token provided during login.
   */
  get token() {
    return this.#token!;
  }

  /**
   * The logged in bot as a discord user.
   */
  get user() {
    return this.#user!;
  }

  /**
   * The logged in bot's application ID.
   */
  get clientId() {
    return this.#clientId!;
  }

  /**
   * Whether the bot is logged in or not.
   */
  get isReady() {
    return this.#ready;
  }

  /**
   * Sends a websocket payload to the discord server as a specific shard or all shards.
   *
   * @param data The data to be sent.
   * @param shardId The shard which has to send the data (if only a specific shard needs to send this data).
   */
  wsSend(data: { op: number; d: any }, shardId?: number) {
    if (!data) throw new Error('No data to send.').stack;
    else {
      if (!shardId) this.shardManager.each((shard) => shard.ws.send(JSON.stringify(data)));
      else {
        if (this.shardManager.get(shardId)) this.shardManager.get(shardId).ws.send(JSON.stringify(data));
        else throw new Error('Invalid shard ID.').stack;
      }
    }
  }

  /**
   * Closes a specific shard's connection to discord.
   *
   * @param shardId The shard that needs to be closed.
   */
  wsClose(shardId?: number) {
    if (shardId) {
      if (this.shardManager.get(shardId)) {
        this.shardManager.get(shardId).ws.close();
        this.shardManager.delete(shardId);
        this.emit('shardDisconnected', shardId);
      } else throw new Error('Invalid shard ID.').stack;
    } else {
      this.shardManager.each((shard) => shard.ws.close());
      this.shardManager.clear();
      this.emit('disconnected');
    }
  }

  /**
   * Emits one of the client's event for the handler to handle.
   *
   * @param event the event to be emitted.
   * @param params The parameters to be passed onto the event handler.
   */
  emit(event: string, ...params: any[]) {
    if (this.#eventHandler.get(event)) this.#eventHandler.get(event)!(...params);
  }

  /**
   * Connects to the discord servers and logs in as the bot.
   *
   * @param token The discord bot token.
   * @param options Additional login options.
   */
  async login(
    token: string,
    options: { presence: Presence; sharding?: { shardId: number; totalShards: number }; shardCount?: number } = {
      presence: { status: 'online', afk: false }
    }
  ) {
    try {
      this.#clientId = atob(token.split('.')[0]);

      this.emit('debug', yellow('Getting gateway info.'));
      let gatewayResponse = await fetch(`${this.httpBase}/gateway/bot`, {
        method: 'GET',
        headers: { Authorization: `Bot ${token}` }
      });
      if (gatewayResponse.status !== 200) {
        throw new HTTPError(gatewayResponse).stack;
      }
      let gateway = await gatewayResponse.json();
      if (gateway['session_start_limit'].remaining < 1) {
        console.error(
          red(
            `You've hit your connection limit. The limit will reset on ${new Date(
              Date.now() + gateway['session_start_limit'].reset_after
            )}`
          )
        );
        Deno.exit(-1);
      }
      this.emit('debug', green('Gateway info successfully fetched.'));
      this.#token = token;
      this.#wsBase = gateway.url + '?v=6&encoding=6';
      this.#shardCount = options.shardCount || gateway.shards;

      this.emit('debug', yellow('Trying to connect to discord ws servers.'));
      if (options.sharding) {
        this.#shardCount = options.sharding.totalShards;
        this.instantiateShard(options.sharding.shardId, options.presence);
      } else {
        for (let i = 0; i < this.#shardCount; i++) {
          this.instantiateShard(i, options.presence);
        }
      }
    } catch (err) {
      console.error(err);
    }
  }

  private instantiateShard(shardId: number, presence: Presence) {
    setTimeout(() => {
      let newShard = new Shard(this, { shardId: shardId, total: this.#shardCount }, this.#wsBase, presence);
      newShard.on('ready', (rawData) => {
        rawData.guilds.forEach((guild: any) => {
          this.guilds.set(guild.id, guild);
        });
        this.emit('shardReady', newShard.id);
        if (this.shardManager.size === this.#shardCount && this.shardManager.every((shard) => shard.isReady)) {
          this.#user = new ClientUser(this, rawData['user'], presence);
        }
      });
      newShard.on('guildCreate', (guild: any) => {
        this.guilds.set(guild.id, guild);
        guild.members.map((x: any) => {
          x.user.presence = guild.presences.find((p: any) => p.user.id === x.user.id);
          return x;
        });
        delete guild.presences;
        guild.members.forEach((member: any) => this.users.set(member.user.id, member.user));
        guild.channels.forEach((channel: any) => this.channels.set(channel.id, channel));
        if (this.guilds.every((g: any) => !g.unavailable) && !this.#ready) {
          this.#ready = true;
          this.emit('ready');
        }
      });

      newShard.on('channelCreate', (data: any) => {
        this.channels.set(data.id, data);
        if (data.guild_id) {
          let g = this.guilds.get(data.guild_id);
          g.channels[data.id] = data;
          this.guilds.set(g.id, g);
        }
        this.emit('channelCreate', data);
      });

      newShard.on('channelUpdate', (data: any) => {
        this.channels.set(data.id, data);
        if (data.guild_id) {
          let g = this.guilds.get(data.guild_id);
          g.channels[data.id] = data;
          this.guilds.set(g.id, g);
        }
        this.emit('channelCreate', data);
      });

      newShard.on('channelDelete', (data: any) => {
        this.channels.delete(data.id);
        if (data.guild_id) {
          let g = this.guilds.get(data.guild_id);
          delete g.channels[data.id];
          this.guilds.set(g.id, g);
        }
        this.emit('channelDelete', data);
      });

      newShard.on('channelPinsUpdate', (data: any) => {
        let c = this.channels.get(data.channel_id);
        if (c) c.lastPinnedTimestamp = new Date(data.last_pin_timestamp).getTime();
        if (data.guild_id) {
          if (c) this.guilds.get(data.guild_id).channels[data.channel_id] = c;
        }
        this.emit('channelPinsUpdate', data);
      });

      newShard.on('guildUpdate', (data: any) => {
        let guild = this.guilds.get(data.id);
        for (let key of Object.keys(data)) if (guild[key] !== data[key]) guild[key] = data[key];
        this.guilds.set(data.id, guild);
        this.emit('guildUpdate', data);
      });

      newShard.on('guildDelete', (data: any) => {
        let guild = this.guilds.get(data.id);
        this.guilds.delete(guild.id);
        this.emit('guildDelete', guild);
      });

      newShard.on('guildBanAdd', (data: any) => {
        this.emit('guildBanAdd', this.guilds.get(data.guild_id), data.user);
      });

      newShard.on('guildBanRemove', (data: any) => {
        this.emit('guildBanRemove', this.guilds.get(data.guild_id), data.user);
      });

      newShard.on('guildEmojisUpdate', (data: any) => {
        this.emit('guildEmojisUpdate', this.guilds.get(data.guild_id), data.emojis);
      });

      newShard.on('guildIntegrationsUpdate', (data: any) => {
        this.emit('guildIntegrationsUpdate', this.guilds.get(data.guild_id));
      });

      newShard.on('guildMemberAdd', (data: any) => {
        let member = data,
          guild = this.guilds.get(data.guild_id);
        delete member.guild_id;
        guild.members = guild.members.filter((m: any) => m.user.id !== member.user.id);
        guild.members.push(member);
        this.guilds.set(guild.id, guild);
        this.users.set(member.user.id, member.user);
        this.emit('guildMemberAdd', guild, member);
      });

      newShard.on('guildMemberRemove', (data: any) => {
        let guild = this.guilds.get(data.guild_id);
        guild.members = guild.members.filter((m: any) => m.user.id !== data.user.id);
        this.guilds.set(guild.id, guild);
        this.emit('guildMemberRemove', guild, data.user);
      });

      newShard.on('guildMemberUpdate', (data: any) => {
        let guild = this.guilds.get(data.guild_id);
        let member = guild.members.filter((m: any) => m.user.id === data.user.id)[0];
        let oldMember = member !== undefined ? { ...member } : {};
        for (let k of Object.keys(data)) if (member[k] && member[k] !== data[k]) member[k] = data[k];
        guild.members = guild.members.filter((m: any) => m.user.id !== member.user.id);
        guild.members.push(member);
        this.guilds.set(guild.id, guild);
        this.users.set(member.user.id, member.user);
        this.emit('guildMemberUpdate', guild, oldMember, member);
      });

      newShard.on('guildMembersChunk', (data: any) => {
        let guild = this.guilds.get(data.guild_id);
        guild.members.filter((m: any) => !data.members.map((x: any) => x.user.id).includes(m.user.id));
        guild.members.push(...data.members);
        data.members.map((x: any) => {
          x.user.presence = guild.presences.find((p: any) => p.user.id === x.user.id);
          return x;
        });
        data.members.forEach((member: any) => this.users.set(member.user.id, member.user));
        this.guilds.set(guild.id, guild);
      });

      newShard.on('guildRoleCreate', (data: any) => {
        let guild = this.guilds.get(data.guild_id);
        guild.roles = guild.roles.filter((r: any) => r.id !== data.role.id);
        guild.roles.push(data.role);
        this.emit('guildRoleCreate', guild, data.role);
      });

      newShard.on('guildRoleUpdate', (data: any) => {
        let guild = this.guilds.get(data.guild_id);
        let role = guild.roles.filter((r: any) => r.id === data.role.id)[0];
        guild.roles = guild.roles.filter((r: any) => r.id !== data.role.id);
        guild.roles.push(data.role);
        this.emit('guildRoleUpdate', guild, role, data.role);
      });

      newShard.on('guildRoleDelete', (data: any) => {
        let guild = this.guilds.get(data.guild_id);
        let role = guild.roles.filter((r: any) => r.id === data.role.id)[0];
        guild.roles = guild.roles.filter((r: any) => r.id !== data.role.id);
        this.emit('guildRoleDelete', guild, role);
      });

      newShard.on('inviteCreate', (data: any) => {
        this.emit('inviteCreate', this.guilds.get(data.guild_id), data);
      });

      newShard.on('inviteDelete', (data: any) => {
        this.emit('inviteDelete', this.guilds.get(data.guild_id), data);
      });

      newShard.on('messageCreate', (data: any) => {
        this.messages.set(data.id, data);
        let channel = this.channels.get(data.channel_id);
        channel.last_message_id = data.id;
        if (data.guild_id) {
          let g = this.guilds.get(data.guild_id);
          g.channels = g.channels.filter((c: any) => c.id !== channel.id);
          g.channels.push(channel);
          this.guilds.set(g.id, g);
        }
        this.emit('message', data);
      });

      newShard.on('messageUpdate', (data: any) => {
        let oldMessage = this.messages.get(data.id);
        let newMessage = oldMessage !== undefined ? {...oldMessage} : {};
        for (let k of Object.keys(data)) newMessage[k] = data[k];
        this.emit('messageUpdate', oldMessage, newMessage);
      });

      newShard.on('messageDelete', (data: any) => {
        this.emit('messageDelete', this.messages.get(data.id) || data);
      });

      newShard.on('messageDeleteBulk', (data: any) => {
        let deleted = new Collection();
        data.ids.forEach((id: string) => deleted.set(id, this.messages.get(id)));
        this.emit('messageDeleteBulk', deleted, this.channels.get(data.channel_id));
      });

      newShard.on('messageReactionAdd', (data: any) => {
        this.emit('messageReactionAdd', {
          user: this.users.get(data.user_id) || { id: data.user_id },
          channel: this.channels.get(data.channel_id) || { id: data.channel_id },
          message: this.messages.get(data.message_id) || { id: data.message_id },
          emoji: data.emoji,
          guild: data.guild_id !== undefined ? this.guilds.get(data.guild_id) || { id: data.guild_id } : undefined,
          member: data.member
        });
      });

      newShard.on('messageReactionRemove', (data: any) => {
        this.emit('messageReactionRemove', {
          user: this.users.get(data.user_id) || { id: data.user_id },
          channel: this.channels.get(data.channel_id) || { id: data.channel_id },
          message: this.messages.get(data.message_id) || { id: data.message_id },
          emoji: data.emoji,
          guild: data.guild_id !== undefined ? this.guilds.get(data.guild_id) || { id: data.guild_id } : undefined
        });
      });

      newShard.on('messageReactionRemoveAll', (data: any) => {
        this.emit('messageReactionRemoveAll', {
          channel: this.channels.get(data.channel_id) || { id: data.channel_id },
          message: this.messages.get(data.message_id) || { id: data.message_id },
          guild: data.guild_id !== undefined ? this.guilds.get(data.guild_id) || { id: data.guild_id } : undefined
        });
      });

      newShard.on('messageReactionRemoveEmoji', (data: any) => {
        this.emit('messageReactionRemoveEmoji', {
          channel: this.channels.get(data.channel_id) || { id: data.channel_id },
          message: this.messages.get(data.message_id) || { id: data.message_id },
          guild: data.guild_id !== undefined ? this.guilds.get(data.guild_id) || { id: data.guild_id } : undefined,
          emoji: data.emoji
        });
      });

      this.shardManager.set(shardId, newShard);
    }, 5000 * shardId);
  }
}

export default Client;
