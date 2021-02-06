import type {
  APIEmoji,
  APIGuild,
  APIGuildMember,
  Snowflake
} from 'discord-api-types'
import type {
  DataGuild,
  DataGuildEmoji,
  DataGuildMember,
  ResolvedClientData,
  ResolvedData
} from './Data'
import type {Override} from './utils'

export const addGuildID = <T>(dataGuild: DataGuild) => (
  dataChannel: T
): Override<T, {guild_id: Snowflake}> => ({
  ...dataChannel,
  guild_id: dataGuild.id
})

export const guildEmoji = ({users}: ResolvedData) => ({
  id,
  name,
  roles,
  user_id,
  require_colons,
  managed,
  animated,
  available
}: DataGuildEmoji): APIEmoji => ({
  id,
  name,
  roles,
  user: users.get(user_id)!,
  require_colons,
  managed,
  animated,
  available
})

export const guildMember = ({users}: ResolvedData) => (
  dataGuild: DataGuild,
  includePending = false
) => ({
  id,
  nick,
  roles,
  joined_at,
  premium_since,
  pending
}: DataGuildMember): APIGuildMember => {
  const {deaf, mute} = dataGuild.voice_states.find(
    ({user_id}) => user_id === id
  ) ?? {deaf: false, mute: false}
  return {
    user: users.get(id)!,
    nick,
    roles,
    joined_at,
    premium_since,
    deaf,
    mute,
    ...(includePending ? {pending} : {})
  }
}

/**
 * Converts a `DataGuild` into an `APIGuild`. This does not include fields only
 * sent in `GUILD_CREATE`, Get Current User Guilds, and in Get Guild
 * without `with_counts`.
 *
 * @param data The backend data.
 * @returns A function for converting a guild object in the backend
 * representation into a guild for returning from the mocked API.
 */
export const guild = (
  data: ResolvedData
): ((dataGuild: DataGuild) => APIGuild) => {
  const convertGuildEmoji = guildEmoji(data)
  return ({
    id,
    name,
    icon,
    splash,
    discovery_splash,
    owner_id,
    region,
    afk_channel_id,
    afk_timeout,
    widget_enabled,
    widget_channel_id,
    verification_level,
    default_message_notifications,
    explicit_content_filter,
    roles,
    emojis,
    features,
    mfa_level,
    application_id,
    system_channel_id,
    system_channel_flags,
    rules_channel_id,
    max_presences,
    max_members,
    vanity_url_code,
    description,
    banner,
    premium_tier,
    premium_subscription_count,
    preferred_locale,
    public_updates_channel_id,
    max_video_channel_users,
    welcome_screen
  }): APIGuild => ({
    id,
    name,
    icon,
    splash,
    discovery_splash,
    owner_id,
    region,
    afk_channel_id,
    afk_timeout,
    widget_enabled,
    widget_channel_id,
    verification_level,
    default_message_notifications,
    explicit_content_filter,
    roles,
    emojis: emojis.map(convertGuildEmoji),
    features,
    mfa_level,
    application_id,
    system_channel_id,
    system_channel_flags,
    rules_channel_id,
    max_presences,
    max_members,
    vanity_url_code,
    description,
    banner,
    premium_tier,
    premium_subscription_count,
    preferred_locale,
    public_updates_channel_id,
    max_video_channel_users,
    welcome_screen
  })
}

/**
 * {@linkcode guild} but includes fields only sent in `GUILD_CREATE`.
 *
 * @param data The backend data.
 * @param clientData The backend client data.
 * @returns A function for converting a guild object in the backend
 * representation into a guild for returning from the mocked API.
 */
export const guildCreateGuild = (
  data: ResolvedData,
  {userID}: ResolvedClientData
): ((dataGuild: DataGuild) => APIGuild) => {
  const convertGuild = guild(data)
  const convertGuildMember = guildMember(data)
  return (dataGuild): APIGuild => {
    const {large, unavailable, members, channels, presences} = dataGuild
    return {
      ...convertGuild(dataGuild),
      joined_at: members.find(({id}) => id === userID)?.joined_at,
      large,
      unavailable,
      member_count: members.length,
      members: members.map(convertGuildMember(dataGuild, true)),
      channels: channels.map(addGuildID(dataGuild)),
      presences: presences.map(addGuildID(dataGuild))
    }
  }
}