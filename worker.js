export default {
  async fetch(request, env) {
    console.log('Received request:', request.method);
    console.log('Request headers:', Object.fromEntries(request.headers));

    // 允許 OPTIONS 請求，這對於 CORS 預檢請求很重要
    if (request.method === 'OPTIONS') {
      console.log('Handling OPTIONS request');
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type, x-line-signature',
        },
      });
    }

    // 主要請求處理邏輯
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error('Error in fetch:', error);
      return new Response('Internal server error', { status: 500 });
    }
  }
};

// 主要請求處理邏輯
async function handleRequest(request, env) {
  try {
    // 驗證請求方法
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // 先讀取 body
    const bodyText = await request.text();
    console.log('Request body:', bodyText);

    // 解析 JSON
    const body = JSON.parse(bodyText);

    // 驗證 LINE 簽名
    const signature = request.headers.get('x-line-signature');
    console.log('LINE signature:', signature);
    
    if (!signature) {
      console.error('Missing LINE signature');
      return new Response('Missing signature', { status: 400 });
    }

    const isValid = await validateSignature(bodyText, signature, env.LINE_CHANNEL_SECRET);
    console.log('Signature validation result:', isValid);
    
    if (!isValid) {
      console.error('Invalid LINE signature');
      return new Response('Invalid signature', { status: 400 });
    }

    // 處理 webhook 事件
    return handleLineWebhook(body, env);
  } catch (error) {
    console.error('Error in handleRequest:', error);
    return new Response('Internal server error', { status: 500 });
  }
}

// 主要處理 LINE Webhook 的邏輯
async function handleLineWebhook(body, env) {
  console.log('Received webhook event:', JSON.stringify(body.events[0], null, 2));

  // 處理驗證請求
  if (!body.events || body.events.length === 0) {
    console.log('Received verification request');
    return new Response('OK', { status: 200 });
  }

  const event = body.events[0];
  const replyToken = event.replyToken;
  const userId = event.source.userId;

  // 確保 message 存在且有 text 屬性
  if (!event.message || !event.message.text) {
    console.log('Received non-text message:', JSON.stringify(event.message, null, 2));
    return new Response('OK', { status: 200 });
  }

  const message = event.message.text;
  console.log(`Processing message from user ${userId}: ${message}`);

  try {
    // 獲取用戶設定
    const userSettings = await getUserSettings(userId, env);
    let quickReplies = QUICK_REPLIES.DEFAULT;

    // 處理特殊命令
    if (message === "忘掉一切吧") {
      await clearConversationHistory(userId, env);
      await replyToUser(replyToken, "已經忘掉所有過去的對話記錄。", env, quickReplies);
      return new Response('OK');
    }

    if (message === "請告訴我你能做什麼") {
      const helpMessage = "我是Francisco，一個AI心理諮商師。我可以：\n" +
        "1. 傾聽你的心事並給予建議\n" +
        "2. 記住我們的對話內容\n" +
        "3. 根據情境調整對話方式\n\n" +
        "特殊功能：\n" +
        "• 輸入「切換對話模式」改變談話風格\n" +
        "• 輸入「忘掉一切吧」清除對話記錄";
      
      quickReplies = QUICK_REPLIES.HELP;
      await replyToUser(replyToken, helpMessage, env, quickReplies);
      return new Response('OK');
    }

    if (message === "切換對話模式" || message.startsWith("切換到")) {
      if (message === "切換對話模式") {
        const modeMessage = "請選擇想要的對話模式：\n" +
          "• 輕鬆模式：像朋友般聊天\n" +
          "• 專業模式：提供專業建議\n" +
          "• 幽默模式：輕鬆有趣的對話";
        await replyToUser(replyToken, modeMessage, env, QUICK_REPLIES.CONVERSATION_MODES);
        return new Response('OK');
      } else {
        const mode = message.replace("切換到", "").replace("模式", "");
        const newMode = {
          "輕鬆": UserSettings.CONVERSATION_MODES.CASUAL,
          "專業": UserSettings.CONVERSATION_MODES.PROFESSIONAL,
          "幽默": UserSettings.CONVERSATION_MODES.HUMOROUS
        }[mode];

        if (newMode) {
          await updateUserSettings(userId, { conversationMode: newMode }, env);
          await replyToUser(replyToken, `已切換到${mode}模式！`, env, QUICK_REPLIES.DEFAULT);
          return new Response('OK');
        }
      }
    }

    // 獲取對話歷史
    const history = await getConversationHistory(userId, env);
    history.push({ role: "user", content: message });

    // 根據用戶設定選擇系統提示詞
    const systemPrompt = SYSTEM_PROMPTS[userSettings.conversationMode || UserSettings.CONVERSATION_MODES.CASUAL];

    console.log('Generating response with conversation history:', JSON.stringify(history, null, 2));
    const reply = await generateGroqResponse(history, message, env, systemPrompt);
    console.log('Generated response:', reply);

    // 儲存對話
    await saveConversation(userId, message, reply, env);
    
    // 發送回覆
    await replyToUser(replyToken, reply, env, quickReplies);
    
    return new Response('OK');
  } catch (error) {
    console.error('Error in handleLineWebhook:', error);
    
    // 根據錯誤類型返回不同的錯誤訊息
    let errorMessage = "抱歉，我現在遇到了一些問題。請稍後再試。";
    if (error.message.includes('Groq API')) {
      errorMessage = "抱歉，我現在思考得有點慢。請稍後再試。";
    }
    
    await replyToUser(replyToken, errorMessage, env, QUICK_REPLIES.DEFAULT);
    return new Response('Error handled', { status: 200 });
  }
}

// 驗證 LINE 簽名
async function validateSignature(bodyText, signature, channelSecret) {
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(channelSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(bodyText)
    );
    const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
    return signature === signatureBase64;
  } catch (error) {
    console.error('Error in validateSignature:', error);
    return false;
  }
}

// 使用者設定相關
const UserSettings = {
  CONVERSATION_MODES: {
    CASUAL: 'casual',
    PROFESSIONAL: 'professional',
    HUMOROUS: 'humorous'
  },
  RESPONSE_LENGTHS: {
    SHORT: 'short',
    MEDIUM: 'medium',
    LONG: 'long'
  }
};

// 系統提示詞模板
const SYSTEM_PROMPTS = {
  [UserSettings.CONVERSATION_MODES.CASUAL]: "你是一位名叫「Francisco」的心理諮商師，性格溫和友善。你會用輕鬆自然的語氣交談，就像朋友一樣。適時使用表情符號來增添溫度，但不會過度使用。",
  [UserSettings.CONVERSATION_MODES.PROFESSIONAL]: "你是一位名叫「Francisco」的專業心理諮商師，擅長以同理心傾聽並給予專業的建議。你會使用適當的專業術語，但會確保用戶能夠理解。重視邏輯性和實證基礎。",
  [UserSettings.CONVERSATION_MODES.HUMOROUS]: "你是一位名叫「Francisco」的開朗心理諮商師，善於用幽默感化解壓力。你會在適當時機開玩笑或說俏皮話，但不會影響專業性。喜歡用有趣的比喻來解釋概念。"
};

// 快速回覆按鈕設定
const QUICK_REPLIES = {
  DEFAULT: [
    { label: '清除記錄', text: '忘掉一切吧' },
    { label: '說明', text: '請告訴我你能做什麼' },
    { label: '切換模式', text: '切換對話模式' }
  ],
  CONVERSATION_MODES: [
    { label: '輕鬆模式', text: '切換到輕鬆模式' },
    { label: '專業模式', text: '切換到專業模式' },
    { label: '幽默模式', text: '切換到幽默模式' }
  ],
  HELP: [
    { label: '清除記錄', text: '忘掉一切吧' },
    { label: '說明', text: '請告訴我你能做什麼' },
    { label: '切換模式', text: '切換對話模式' }
  ]
};

// KV 存儲相關函數
async function getConversationHistory(userId, env) {
  const key = `chat:${userId}`;
  const history = await env.CHAT_HISTORY.get(key);
  return history ? JSON.parse(history) : [];
}

async function saveConversation(userId, userMessage, botReply, env) {
  const key = `chat:${userId}`;
  const history = await getConversationHistory(userId, env);
  
  history.push(
    { role: "user", content: userMessage },
    { role: "assistant", content: botReply }
  );
  
  // 保持最近的10組對話
  if (history.length > 20) {
    history.splice(0, 2);
  }
  
  await env.CHAT_HISTORY.put(key, JSON.stringify(history));
}

async function clearConversationHistory(userId, env) {
  const key = `chat:${userId}`;
  await env.CHAT_HISTORY.delete(key);
}

// LINE API 相關函數
async function replyToUser(replyToken, text, env, quickReplies = []) {
  const messages = [];
  
  // 如果文字太長，分割成多條訊息
  const maxLength = 2000;
  const textChunks = splitText(text, maxLength);
  
  textChunks.forEach((chunk, index) => {
    const message = {
      type: 'text',
      text: chunk
    };
    
    // 只在最後一條訊息加入快速回覆按鈕
    if (index === textChunks.length - 1 && quickReplies.length > 0) {
      message.quickReply = {
        items: quickReplies.map(reply => ({
          type: 'action',
          action: {
            type: 'message',
            label: reply.label,
            text: reply.text
          }
        }))
      };
    }
    
    messages.push(message);
  });

  await sendMultipleMessages(replyToken, messages, env);
}

async function pushMessage(userId, message, env, quickReplies = []) {
  const messageObject = {
    type: 'text',
    text: message,
    quickReply: quickReplies.length > 0 ? {
      items: quickReplies.map(reply => ({
        type: 'action',
        action: {
          type: 'message',
          label: reply.label,
          text: reply.text
        }
      }))
    } : undefined
  };

  console.log('Sending push message with quick replies:', JSON.stringify(messageObject, null, 2));

  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      to: userId,
      messages: [messageObject]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('LINE API error response:', errorText);
    throw new Error(`LINE API error: ${response.status}`);
  }
}

// Groq API 相關函數
async function generateGroqResponse(history, message, env, systemPrompt, fallbackLevel = 0) {
  try {
    // 如果對話歷史太長，保留最近的部分
    if (history.length > 10) {
      history = history.slice(-10);
    }

    const model = chooseModel(message, fallbackLevel);
    const requestBody = {
      model: model,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        ...history
      ],
      max_tokens: 300,
      temperature: 0.7,
      presence_penalty: 0.6,
      frequency_penalty: 0.3
    };

    console.log('Sending request to Groq API with model:', model);
    
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      if (response.status === 429 && fallbackLevel < 2) {
        console.log('Rate limit reached, trying fallback model');
        return generateGroqResponse(history, message, env, systemPrompt, fallbackLevel + 1);
      }
      throw new Error(`Groq API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;

  } catch (error) {
    console.error('Error in generateGroqResponse:', error);
    if (error.message.includes('rate limit')) {
      return "抱歉，我需要稍作休息。請過幾分鐘再跟我聊天，或是換個較簡短的話題。";
    }
    throw error;
  }
}

// 修改 chooseModel 函數，固定使用 llama-3.1-8b-instant
function chooseModel(message, fallbackLevel = 0) {
  return 'llama-3.1-8b-instant';
}

// 輔助函數：分割文字
function splitText(text, maxLength = 2000) {
  const chunks = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    
    // 智能尋找切割點
    let cutoff = -1;
    const searchRange = remaining.substring(0, maxLength);
    
    // 優先順序：句號 > 驚嘆號 > 問號 > 換行 > 逗號
    const punctuations = ['。', '！', '？', '\n', '，'];
    for (const punct of punctuations) {
      cutoff = searchRange.lastIndexOf(punct);
      if (cutoff !== -1) {
        cutoff++; // 包含標點符號
        break;
      }
    }
    
    // 如果找不到合適的切割點，就在最大長度處切割
    if (cutoff === -1) {
      cutoff = maxLength;
    }
    
    chunks.push(remaining.substring(0, cutoff));
    remaining = remaining.substring(cutoff).trim();
  }
  
  return chunks.filter(chunk => chunk.length > 0); // 過濾掉空字串
}

// 用戶設定相關函數
async function getUserSettings(userId, env) {
  try {
    const settings = await env.CHAT_HISTORY.get(`settings:${userId}`);
    return settings ? JSON.parse(settings) : {
      conversationMode: UserSettings.CONVERSATION_MODES.CASUAL,
      responseLength: UserSettings.RESPONSE_LENGTHS.MEDIUM,
      language: 'zh-TW'
    };
  } catch (error) {
    console.error('Error getting user settings:', error);
    return {
      conversationMode: UserSettings.CONVERSATION_MODES.CASUAL,
      responseLength: UserSettings.RESPONSE_LENGTHS.MEDIUM,
      language: 'zh-TW'
    };
  }
}

async function updateUserSettings(userId, newSettings, env) {
  try {
    const currentSettings = await getUserSettings(userId, env);
    const updatedSettings = { ...currentSettings, ...newSettings };
    await env.CHAT_HISTORY.put(`settings:${userId}`, JSON.stringify(updatedSettings));
    return updatedSettings;
  } catch (error) {
    console.error('Error updating user settings:', error);
    throw error;
  }
}

// 多媒體回應相關函數
async function sendMultipleMessages(replyToken, messages, env) {
  try {
    const response = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        replyToken: replyToken,
        messages: messages
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to send messages: ${response.status}`);
    }
  } catch (error) {
    console.error('Error sending messages:', error);
    throw error;
  }
}