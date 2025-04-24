const fs = require('fs')
const path = require('path')
const dotenv = require('dotenv')
const { Telegraf,Markup } = require('telegraf')
const { message } = require('telegraf/filters');
const { HttpsProxyAgent } = require('https-proxy-agent')
const { createCanvas } = require('canvas')

// 获取当前环境变量
const env = process.env.NODE_ENV || 'development'
const envFilePath = path.resolve(process.cwd(), `.env.${env}`)

// 加载 .env 文件
if (fs.existsSync(envFilePath)) {
    dotenv.config({ path: envFilePath })
    console.log(`Loaded environment variables from ${envFilePath}`)
} else {
    dotenv.config()
    console.log('Loaded environment variables from default .env')
}

// 获取 bot_token
const { bot_token, bot_name, http_proxy } = process.env

if (!bot_token || !bot_name) {
    console.error('❌ bot_token 或 bot_name 缺失，请检查 .env')
    process.exit(1)
}

console.log('✅ Environment Variables loaded')
console.log({ bot_token, env })

// 初始化 bot
let bot = http_proxy
    ? new Telegraf(bot_token, { telegram: { agent: new HttpsProxyAgent(http_proxy) } })
    : new Telegraf(bot_token)

const pendingVerifications = new Map()

// 生成图形验证码
function generateCaptcha() {
    const canvas = createCanvas(150, 50)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#f0f0f0'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const answer = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')

    ctx.font = '30px Sans'
    ctx.fillStyle = '#333'
    ctx.fillText(answer, 20, 35)

    const options = [answer]
    while (options.length < 4) {
        const fake = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
        if (!options.includes(fake)) options.push(fake)
    }

    options.sort(() => Math.random() - 0.5)

    return {
        imageBuffer: canvas.toBuffer(),
        answer,
        options
    }
}

// 新人加入触发
bot.on('new_chat_members', async (ctx) => {
    const chatId = ctx.chat.id

    for (const member of ctx.message.new_chat_members) {
        const userId = member.id
        const username = member.username || member.first_name

        // 忽略机器人自身
        if (username?.toLowerCase() === bot_name.toLowerCase()) {
            console.log(`👀 忽略机器人自身 (${bot_name}) 加入群组`)
            continue
        }

        const { imageBuffer, answer, options } = generateCaptcha()

        const inlineKeyboard = Markup.inlineKeyboard(
            options.map(opt => Markup.button.callback(opt, `verify_${userId}_${opt}_${chatId}`)),
            { columns: 2 }
        )

        // 发送图片 + 验证按钮
        await ctx.replyWithPhoto(
            { source: imageBuffer },
            {
                caption: `👋 欢迎 @${username}，请点击正确的验证码（5分钟内验证）`,
                reply_markup: inlineKeyboard.reply_markup
            }
        )

        // 记录验证状态
        pendingVerifications.set(userId, {
            answer,
            timeout: setTimeout(async () => {
                try {
                    await ctx.telegram.kickChatMember(chatId, userId)
                    await ctx.telegram.unbanChatMember(chatId, userId)
                    await ctx.reply(`❌ @${username} 验证超时，已被移出。`)
                } catch (err) {
                    console.error('踢出失败：', err)
                }
                pendingVerifications.delete(userId)
            }, 5 * 60 * 1000)
        })
    }
})

// 回调按钮处理
bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data
    const [_, userId, selected, chatId] = data.split('_')
    const fromId = ctx.from.id

    if (String(fromId) !== userId) {
        return ctx.answerCbQuery('❌ 这不是你的验证码')
    }

    const verifyData = pendingVerifications.get(Number(userId))
    if (!verifyData) {
        return ctx.answerCbQuery('⚠️ 验证已过期或不存在')
    }

    if (selected === verifyData.answer) {
        clearTimeout(verifyData.timeout)
        pendingVerifications.delete(Number(userId))
        await ctx.answerCbQuery('✅ 验证成功，欢迎加入！')
        await ctx.editMessageCaption({ caption: '✅ 验证成功，欢迎加入！' })
    } else {
        clearTimeout(verifyData.timeout)
        pendingVerifications.delete(Number(userId))
        await ctx.answerCbQuery('❌ 验证失败，将被移出')
        try {
            await ctx.telegram.kickChatMember(chatId, Number(userId))
            await ctx.telegram.unbanChatMember(chatId, Number(userId))
            await ctx.editMessageCaption({ caption: '❌ 验证失败，已踢出。' })
        } catch (err) {
            console.error('踢人失败：', err)
        }
    }
})


// 常规命令
bot.start((ctx) => ctx.reply('你好！这是 QIT 群管机器人。\n项目地址： https://github.com/xmexg/qitgroupbot'))
bot.help((ctx) => ctx.reply('本机器人会对新成员进行图形验证码验证，验证失败或超时将自动踢出。'))

bot.launch()
console.log('🚀 Bot is running...')
