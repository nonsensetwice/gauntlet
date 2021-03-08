import md from 'discord-markdown'
import {
  AllowedMentionsTypes,
  GatewayDispatchEvents,
  GatewayIntentBits,
  PermissionFlagsBits
} from 'discord-api-types/v8'
import * as convert from '../../../convert'
import * as defaults from '../../../defaults'
import {attachmentURLs, clientUserID, pick, omit} from '../../../utils'
import {getChannel, getPermissions, hasPermissions} from '../../utils'
import {Method, error, errors, formBodyErrors} from '../../../errors'
import type {
  APIAllowedMentions,
  APIEmbed,
  RESTPostAPIChannelMessageJSONBody,
  RESTPostAPIChannelMessageResult,
  Snowflake
} from 'discord-api-types/v8'
import type {EmitPacket, HasIntents} from '../../../Backend'
import type {FormBodyError, FormBodyErrors} from '../../../errors'
import type {
  DataEmbed,
  DataGuild,
  DataGuildChannel,
  DataMessage,
  ResolvedClientData,
  ResolvedData
} from '../../../types'
import type {AttachmentURLs, RequireKeys} from '../../../utils'
import type {File} from '../../types'

export type MessagesPost = (options: {
  data: RESTPostAPIChannelMessageJSONBody
  files?: File[]
}) => Promise<RESTPostAPIChannelMessageResult>

// #region Errors

const MAX_NONCE = 25
const MAX_EMBED_COLOR = 0xff_ff_ff
const MAX_URL = 2048
const ATTACHMENT_SCHEME = 'attachment://'

const lengthErr = (
  value: string | undefined,
  max: number
): FormBodyError | undefined =>
  (value ?? '').length > max
    ? formBodyErrors.BASE_TYPE_MAX_LENGTH(max)
    : undefined

const lengthError = (
  value: string | undefined,
  max: number,
  key: string,
  key2?: string
): FormBodyErrors => {
  const err = lengthErr(value, max)
  if (err) {
    const errs: FormBodyErrors[string] = {_errors: [err]}
    return {
      [key]: key2 === undefined ? errs : {[key2]: errs}
    }
  }
  return {}
}

const getEmbedErrors = ({
  title = '',
  description = '',
  url,
  timestamp = '',
  color = 0,
  footer: {text: footerText, icon_url: footerIconURL} = {text: ''},
  image: {url: imageURL} = {},
  thumbnail: {url: thumbnailURL} = {},
  video: {url: videoURL} = {},
  provider: {name: providerName} = {},
  author: {name: authorName = '', url: authorURL} = {},
  fields
}: APIEmbed): FormBodyErrors[string] => {
  if (
    title.length +
      description.length +
      (fields?.reduce(
        (acc, {name, value}) => acc + name.length + value.length,
        0
      ) ?? 0) +
      footerText.length +
      authorName.length >
    6000
  )
    return {_errors: [formBodyErrors.MAX_EMBED_SIZE_EXCEEDED]}

  const colorError =
    color < 0
      ? formBodyErrors.NUMBER_TYPE_MIN(0)
      : color > MAX_EMBED_COLOR
      ? formBodyErrors.NUMBER_TYPE_MAX(MAX_EMBED_COLOR)
      : undefined
  const fieldsErrors =
    fields?.reduce<FormBodyErrors>((errs, {name, value}, i) => {
      const nameErr = name
        ? lengthErr(name, 256)
        : formBodyErrors.BASE_TYPE_REQUIRED
      const valueErr = value
        ? lengthErr(value, 1024)
        : formBodyErrors.BASE_TYPE_REQUIRED
      return nameErr || valueErr
        ? {
            ...errs,
            [i]: {
              ...(nameErr ? {name: {_errors: [nameErr]}} : {}),
              ...(valueErr ? {value: {_errors: [valueErr]}} : {})
            }
          }
        : errs
    }, {}) ?? {}
  return {
    ...lengthError(title, 256, 'title'),
    ...lengthError(description, 2048, 'description'),
    // I'm not bothering to validate URLs
    ...lengthError(url, MAX_URL, 'url'),
    ...(timestamp && new Date(timestamp).toISOString() !== timestamp
      ? {
          timestamp: {
            _errors: [formBodyErrors.DATE_TIME_TYPE_PARSE(timestamp)]
          }
        }
      : {}),
    ...(colorError ? {color: {_errors: [colorError]}} : {}),
    ...lengthError(footerText, 2048, 'footer', 'text'),
    ...lengthError(footerIconURL, MAX_URL, 'footer', 'icon_url'),
    ...lengthError(imageURL, MAX_URL, 'image', 'url'),
    ...lengthError(thumbnailURL, MAX_URL, 'thumbnail', 'url'),
    ...lengthError(videoURL, MAX_URL, 'video', 'url'),
    ...lengthError(providerName, 256, 'provider', 'name'),
    ...lengthError(authorName, 256, 'author', 'name'),
    ...lengthError(authorURL, MAX_URL, 'author', 'url'),
    ...(Object.keys(fieldsErrors).length ? {fields: fieldsErrors} : {})
  }
}

const getAllowedMentionsErrors = (
  allowed: APIAllowedMentions
): FormBodyErrors[string] => {
  const lengthOrSetErr = (
    key: Exclude<keyof APIAllowedMentions, 'replied_user'>,
    checkLength = true
  ): FormBodyErrors | undefined => {
    const value: readonly string[] | undefined = allowed[key]
    if (!value) return
    if (checkLength && value.length > 100)
      return {[key]: {_errors: [formBodyErrors.BASE_TYPE_MAX_LENGTH(100)]}}
    const errs = value.reduce<FormBodyErrors>(
      (es, id, i) =>
        value.indexOf(id) < i
          ? {
              ...es,
              [i]: {_errors: [formBodyErrors.SET_TYPE_ALREADY_CONTAINS_VALUE]}
            }
          : es,
      {}
    )
    return Object.keys(errs).length ? {[key]: errs} : undefined
  }
  const lengthAndSetErrs: FormBodyErrors = {
    ...lengthOrSetErr('parse', false),
    ...lengthOrSetErr('roles'),
    ...lengthOrSetErr('users')
  }
  if (Object.keys(lengthAndSetErrs).length) return lengthAndSetErrs

  const mutuallyExclusiveErr = (
    type: Exclude<AllowedMentionsTypes, AllowedMentionsTypes.Everyone>
  ): readonly FormBodyError[] =>
    (allowed.parse?.includes(type) ?? false) && (allowed[type]?.length ?? 0)
      ? [formBodyErrors.MESSAGE_ALLOWED_MENTIONS_PARSE_EXCLUSIVE(type)]
      : []
  const mutuallyExclusiveErrs = [
    ...mutuallyExclusiveErr(AllowedMentionsTypes.User),
    ...mutuallyExclusiveErr(AllowedMentionsTypes.Role)
  ]
  return mutuallyExclusiveErrs.length ? {_errors: mutuallyExclusiveErrs} : {}
}

const getFormErrors = ({
  allowed_mentions,
  content,
  nonce,
  embed
}: RequireKeys<
  Pick<
    RESTPostAPIChannelMessageJSONBody,
    'allowed_mentions' | 'content' | 'embed' | 'nonce'
  >,
  'content'
>): FormBodyErrors => {
  const nonceError =
    typeof nonce == 'string' && nonce.length > MAX_NONCE
      ? formBodyErrors.NONCE_TYPE_TOO_LONG
      : typeof nonce == 'number'
      ? Number.isInteger(nonce)
        ? undefined
        : formBodyErrors.NONCE_TYPE_INVALID_TYPE
      : undefined
  const embedErrs = embed ? getEmbedErrors(embed) : {}
  const allowedMentionsErrs = allowed_mentions
    ? getAllowedMentionsErrors(allowed_mentions)
    : {}
  const errs: FormBodyErrors = {
    ...lengthError(content, 2000, 'content'),
    ...(nonceError ? {nonce: {_errors: [nonceError]}} : {}),
    ...(Object.keys(embedErrs).length ? {embed: embedErrs} : {}),
    ...(Object.keys(allowedMentionsErrs).length
      ? {allowed_mentions: allowedMentionsErrs}
      : {})
  }
  return errs
}

// #endregion

interface Mentions {
  everyone: boolean
  users: Set<Snowflake>
  roles: Set<Snowflake>
}

const emptyMentions: Mentions = {
  everyone: false,
  users: new Set(),
  roles: new Set()
}

const foldMapMentions = (nodes: readonly md.ASTNode[]): Mentions =>
  nodes.reduce<Mentions>(({everyone, users, roles}, child) => {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- recursive
    const mentions = getMentions(child)
    return {
      everyone: everyone || mentions.everyone,
      users: new Set([...users, ...mentions.users]),
      roles: new Set([...roles, ...mentions.roles])
    }
  }, emptyMentions)

const getMentions = (node: md.ASTNode): Mentions => {
  switch (node.type) {
    case 'discordEveryone':
    case 'discordHere':
      return {...emptyMentions, everyone: true}
    case 'discordUser':
      return {...emptyMentions, users: new Set([node.id as Snowflake])}
    case 'discordRole':
      return {...emptyMentions, roles: new Set([node.id as Snowflake])}
    default:
      return 'content' in node && typeof node.content != 'string'
        ? foldMapMentions(node.content)
        : emptyMentions
  }
}

const filterMentions = (
  mentions: Mentions,
  allowed: APIAllowedMentions | undefined
): Pick<Mentions, 'everyone'> & Record<'roles' | 'users', Snowflake[]> => {
  const {everyone} = mentions
  const users = [...mentions.users]
  const roles = [...mentions.roles]

  if (!allowed) return {everyone, users, roles}

  const parse = new Set(allowed.parse)
  const allowedUsers = new Set(allowed.users)
  const allowedRoles = new Set(allowed.roles)
  return {
    everyone: everyone && parse.has(AllowedMentionsTypes.Everyone),
    users: parse.has(AllowedMentionsTypes.User)
      ? users
      : users.filter(id => allowedUsers.has(id)),
    roles: parse.has(AllowedMentionsTypes.Role)
      ? roles
      : roles.filter(id => allowedRoles.has(id))
  }
}

export default (
  data: ResolvedData,
  clientData: ResolvedClientData,
  hasIntents: HasIntents,
  emitPacket: EmitPacket
) => (channelID: Snowflake): MessagesPost => async ({
  data: {content = '', nonce, tts, embed, allowed_mentions, message_reference},
  files
}): Promise<RESTPostAPIChannelMessageResult> => {
  // Errors
  const path = `/channels/${channelID}/messages`
  const method = Method.POST
  const userID = clientUserID(data, clientData)

  const checkPermissions = (
    guild: DataGuild,
    channel: DataGuildChannel
  ): bigint => {
    const permissions = getPermissions(
      guild,
      guild.members.find(member => member.id === userID)!,
      channel
    )
    if (!hasPermissions(permissions, PermissionFlagsBits.VIEW_CHANNEL))
      error(errors.MISSING_ACCESS, path, method)
    if (
      !hasPermissions(
        permissions,
        PermissionFlagsBits.SEND_MESSAGES |
          (files?.length ?? 0 ? PermissionFlagsBits.ATTACH_FILES : BigInt(0)) |
          (embed ? PermissionFlagsBits.EMBED_LINKS : BigInt(0))
      )
    )
      error(errors.MISSING_PERMISSIONS, path, method)
    return permissions
  }

  // if hasn't connected to gateway: 400, {"message": "Unauthorized", "code": 40001}
  // Basic validation
  const formErrs = getFormErrors({allowed_mentions, content, nonce, embed})
  if (Object.keys(formErrs).length)
    error(errors.INVALID_FORM_BODY, path, method, formErrs)

  // Unknown channel
  const [guild, channel] = getChannel(data)(channelID)
  if (!channel) error(errors.UNKNOWN_CHANNEL, path, method)

  // Permissions
  const permissions = guild
    ? checkPermissions(guild, channel as DataGuildChannel)
    : undefined

  // Empty message
  if (!content && !embed && !(files?.length ?? 0))
    error(errors.EMPTY_MESSAGE, path, method)

  // Replies
  if (message_reference) {
    let err: FormBodyError | undefined
    if (message_reference.channel_id !== channelID)
      err = formBodyErrors.REPLIES_CANNOT_REFERENCE_OTHER_CHANNEL
    if (message_reference.guild_id !== guild?.id)
      err = formBodyErrors.REPLIES_UNKNOWN_MESSAGE
    if (err) {
      error(errors.INVALID_FORM_BODY, path, method, {
        message_reference: {_errors: [err]}
      })
    }
  }

  const mentions = filterMentions(
    foldMapMentions(md.parser(content)),
    allowed_mentions
  )
  const canMentionEveryone =
    permissions !== undefined &&
    hasPermissions(permissions, PermissionFlagsBits.MENTION_EVERYONE)
  const base = defaults.dataMessage(channelID)({
    content,
    nonce,
    tts:
      (tts ?? false) &&
      permissions !== undefined &&
      hasPermissions(permissions, PermissionFlagsBits.SEND_TTS_MESSAGES),
    author_id: userID,
    message_reference,
    mention_everyone: mentions.everyone && guild && canMentionEveryone,
    mentions: mentions.users.filter(id => data.users.has(id)),
    mention_roles: guild
      ? mentions.roles.filter(id => {
          const role = guild.roles.find(r => r.id === id)
          return role && (role.mentionable || canMentionEveryone)
        })
      : []
  })

  const resolveURL: {
    <T extends {icon_url?: string}>(object: T, icon: true): T
    <T extends {url?: string}>(object: T, icon?: false): T
  } = <T extends Record<string, unknown>>(object: T, icon = false): T => {
    const fileURL = object[icon ? 'url' : 'icon_url'] as string | undefined
    let urls: AttachmentURLs | undefined
    if (fileURL?.startsWith(ATTACHMENT_SCHEME) ?? false) {
      const file = files?.find(
        ({name}) => name === fileURL!.slice(ATTACHMENT_SCHEME.length)
      )
      if (file) urls = attachmentURLs(channelID, base.id, file.name)
    }
    return {...object, ...urls}
  }

  const resolveEmbed = ({
    title,
    description,
    url,
    timestamp,
    color,
    footer,
    image,
    thumbnail,
    author,
    fields
  }: APIEmbed): DataEmbed =>
    defaults.dataEmbed({
      title,
      description,
      url,
      timestamp,
      color: color === undefined ? undefined : Math.floor(color),
      // Not bothering with proxied URls that an
      // https://images-ext-1.discordapp.net/external/aVEDne7SrZM-yQgNzl8kSN6ljPFN4SbV5ev7oSSji5Q/https/some-website.com/image.png
      footer: footer
        ? resolveURL(omit(footer, 'proxy_icon_url'), true)
        : undefined,
      // Also not bothering with height/widths
      image: image ? resolveURL(pick(image, 'url')) : undefined,
      thumbnail: thumbnail ? resolveURL(pick(thumbnail, 'url')) : undefined,
      author: author
        ? resolveURL(omit(author, 'proxy_icon_url'), true)
        : undefined,
      fields: fields?.slice(0, 25)
    })

  const defaultAttachment = defaults.attachment(channelID, base.id)
  const message: DataMessage = {
    ...base,
    embeds: embed ? [resolveEmbed(embed)] : [],
    attachments:
      files?.map(({name}) => defaultAttachment({filename: name})) ?? []
  }

  channel.messages!.push(message)
  channel.last_message_id = message.id

  const apiMessage = convert.message(data, channelID)(message)
  if (
    hasIntents(
      guild
        ? GatewayIntentBits.GUILD_MESSAGES
        : GatewayIntentBits.DIRECT_MESSAGES
    )
  )
    emitPacket(GatewayDispatchEvents.MessageCreate, apiMessage)
  return apiMessage
}