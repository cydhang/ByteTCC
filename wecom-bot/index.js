const cloud = require('tcb-admin-node');
const axios = require('axios');
const { decrypt, getSignature } = require('@wecom/crypto');
const xml2js = require('xml2js');

// === 配置区域 ===
const CONFIG = {
    CORP_ID: '你的企业ID',
    AGENT_ID: '你的应用AgentID', // 数字字符串
    SECRET: '你的应用Secret',
    TOKEN: '你的API Token',
    AES_KEY: '你的EncodingAESKey',
    ENV_ID: '你的云环境ID'
};

// 初始化云开发
cloud.init({ env: CONFIG.ENV_ID });
const db = cloud.database();

exports.main = async (event, context) => {
    const { httpMethod, queryString, body } = event;

    // 1. 处理企业微信的握手验证 (GET请求)
    if (httpMethod === 'GET') {
        return handleVerification(queryString);
    }

    // 2. 处理消息推送 (POST请求)
    if (httpMethod === 'POST') {
        return await handleMessage(event, queryString, body);
    }

    return 'Method not allowed';
};

// --- 核心逻辑函数 ---

// 验证逻辑
function handleVerification(query) {
    const { msg_signature, timestamp, nonce, echostr } = query;
    const signature = getSignature(CONFIG.TOKEN, timestamp, nonce, echostr);

    if (signature === msg_signature) {
        const { message } = decrypt(CONFIG.AES_KEY, echostr);
        return message; // 返回解密后的明文，完成握手
    }
    return 'Auth Failed';
}

// 消息处理逻辑
async function handleMessage(event, query, body) {
    const { msg_signature, timestamp, nonce } = query;

    // 云函数接收到的 body 可能是 Base64，需要转 Buffer
    // 腾讯云 HTTP 触发器 body 默认为字符串，如果是 XML 可能会有编码问题，建议如下处理：
    let xmlStr = body;
    if (event.isBase64Encoded) {
        xmlStr = Buffer.from(body, 'base64').toString('utf-8');
    }

    // 解析 XML
    const parser = new xml2js.Parser({ explicitArray: false });
    const xmlObj = await parser.parseStringPromise(xmlStr);
    const encryptMsg = xmlObj.xml.Encrypt;

    // 验证签名
    const signature = getSignature(CONFIG.TOKEN, timestamp, nonce, encryptMsg);
    if (signature !== msg_signature) return 'Signature Error';

    // 解密内容
    const { message } = decrypt(CONFIG.AES_KEY, encryptMsg);
    const msgObj = await parser.parseStringPromise(message);
    const finalMsg = msgObj.xml;

    const fromUser = finalMsg.FromUserName;
    const content = finalMsg.Content;

    console.log(`收到消息 [${fromUser}]: ${content}`);

    // === 业务逻辑区 ===
    // 这里接入 AI 或 业务查询
    // 注意：企业微信要求 5s 内响应。如果 AI 慢，建议先回复空，再异步发消息。
    // 这里演示直接回复：

    if (content === '测试') {
        await sendWeComMsg(fromUser, '测试成功！系统运行正常。');
    } else {
        // 简单复读，此处可替换为 AI 接口调用
        await sendWeComMsg(fromUser, `你说的是：${content}`);
    }
    // ================

    return 'success'; // 必须返回 success
}

// --- 工具函数 ---

// 获取 AccessToken (带数据库缓存)
async function getAccessToken() {
    const collection = db.collection('wechat_token');
    // 查库
    const res = await collection.limit(1).get();
    const now = Math.floor(Date.now() / 1000);

    if (res.data.length > 0) {
        const tokenData = res.data[0];
        // 如果有效期还剩 5 分钟以上，直接用
        if (tokenData.expires_at > now + 300) {
            return tokenData.access_token;
        }
    }

    // 重新获取
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CONFIG.CORP_ID}&corpsecret=${CONFIG.SECRET}`;
    const { data } = await axios.get(url);

    if (data.errcode === 0) {
        // 存库 (覆盖更新)
        const record = {
            access_token: data.access_token,
            expires_at: now + 7200 // 2小时有效期
        };
        if (res.data.length > 0) {
            await collection.doc(res.data[0]._id).update(record);
        } else {
            await collection.add(record);
        }
        return data.access_token;
    }
    throw new Error('Get Token Failed: ' + data.errmsg);
}

// 主动发送消息
async function sendWeComMsg(toUser, content) {
    const token = await getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

    await axios.post(url, {
        touser: toUser,
        msgtype: 'text',
        agentid: CONFIG.AGENT_ID,
        text: { content: content }
    });
}
