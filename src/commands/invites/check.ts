import { EMBEDS, MESSAGES } from '@constants'
import { extractCodes, handle, processResults } from '@utils'
import { Command } from 'discord-akairo'
import { CategoryChannel, Collection, GuildChannel, Message, NewsChannel, TextChannel } from 'discord.js'

export default class CheckCommand extends Command {
    public constructor() {
        super('check', {
            aliases: ['check'],
            category: 'Invites',
            channel: 'guild',
            description: {
                text: MESSAGES.COMMANDS.CHECK.TEXT,
                usage: MESSAGES.COMMANDS.CHECK.USAGE
            },
            userPermissions: ['ADMINISTRATOR']
        })
    }

    public async exec(message: Message) {        
        const { config: { categoryIds, checkChannelId, ignoreIds, interval, serverIds }, inCheck } = this.client
        const guildChannelCaches: Collection<string, GuildChannel>[] = this.client.guilds.cache.reduce((acc, guild) => {
            if (serverIds.includes(guild.id))
                acc.push(guild.channels.cache)
            return acc
        }, [])
        const channelCache = new Collection<string, GuildChannel>().concat(...guildChannelCaches)
        const checkChannel = channelCache.get(checkChannelId)

        if (!(checkChannel instanceof TextChannel))
            return message.channel.send(MESSAGES.ERRORS.CHECK_CHANNEL)
        if (checkChannelId !== message.channel.id)
            return message.channel.send(MESSAGES.INFO.WRONG_CHANNEL(checkChannel))
        if (inCheck)
            return message.channel.send(MESSAGES.INFO.IN_CHECK)
        if (!categoryIds.length)
            return message.channel.send(MESSAGES.INFO.NO_CATEGORIES)

        const categories = channelCache
            .filter(({ id, type }) => type === 'category' && categoryIds.includes(id))
            .sort((c1, c2) => (c1.guild.createdTimestamp - c2.guild.createdTimestamp) || (c1.position - c2.position)) as Collection<string, CategoryChannel>
        const delay = ms => new Promise(res => setTimeout(res, ms))
        const delayTask = () => delay(interval)
        const messagesTask = (channel: NewsChannel | TextChannel) => () => handle(channel.messages.fetch({ limit: 8 }, true, false))
        const inviteTask = (code: string) => () => handle(this.client.fetchInvite(code))

        this.client.inCheck = true
        const check = process.hrtime()
        await checkChannel.send(MESSAGES.INFO.CHECK_START(this.client.user.username))
        let goodInvites = 0, badInvites = 0, totalChannels = 0, totalInvites = 0

        for (const [_, category] of categories) {
            const categoryName = category.name
            const guildName = category.guild.name
            const childChannels = category.children
                .filter(({ id, type }) => ['news', 'text'].includes(type) && !ignoreIds.includes(id)) as Collection<string, NewsChannel | TextChannel>

            if (!childChannels.size) {
                await message.channel.send(EMBEDS.CATEGORY(categoryName, guildName))
                continue
            }

            const categoryResults: Collection<string, { code: string, valid: boolean }[]> = new Collection()
            const issues: { unknown: number, known: (NewsChannel | TextChannel)[] } = { unknown: 0, known: [] }
            const childChannelsSorted = childChannels.sort((c1, c2) => c1.position - c2.position)

            for (const [channelId, channel] of childChannelsSorted) {
                if (!channel) {
                    issues.unknown++
                    continue
                }

                const messages = await this.client.queue.add(messagesTask(channel))
                this.client.queue.add(delayTask)

                if (!messages[0]) {
                    issues.known.push(channel)
                    continue
                }

                const codes = extractCodes(messages[0])

                if (!codes.length) {
                    categoryResults.set(channelId, [])
                    continue
                }

                const codePromises = codes.map(code => inviteTask(code))
                const invites = await Promise.allSettled(codePromises.map(codePromise => this.client.queue.add(codePromise))) // invites = { status: 'fulfilled', value: [ [Invite], [DiscordAPIError] ] }[]
                const results = invites.map((invite, index) => {
                    const { value } = invite as any
                    
                    return { code: codes[index], valid: !!value[0] }
                })

                categoryResults.set(channelId, results)
            }

            const { bad, channels, good, issuesDescription, resultsDescription, total } = processResults(categoryResults, issues)

            badInvites += bad
            goodInvites += good
            totalChannels += channels
            totalInvites += total

            await checkChannel.send(EMBEDS.CATEGORY(categoryName, guildName, resultsDescription, issuesDescription))
        }

        this.client.inCheck = false
        const time = process.hrtime(check)
        const elapsedTimeMilliseconds = ((time[0] * 1e9) + time[1]) / 1e6

        await checkChannel.send(MESSAGES.INFO.CHECK_COMPLETE)
        await checkChannel.send(EMBEDS.RESULTS(badInvites, totalChannels, goodInvites, totalInvites, elapsedTimeMilliseconds))
    }
}