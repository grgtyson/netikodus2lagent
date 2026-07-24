require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const axios = require('axios');
const multer = require('multer');
const upload = multer();
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(__dirname));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.sendStatus(401);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return res.sendStatus(401);
  req.user = data.user;
  next();
}

app.get('/auth-config', (req, res) => {
  res.json({ url: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY });
});

const SMS_PROVIDER = process.env.SMS_PROVIDER || 'twilio';

async function logSmsSent(provider, phone, message, providerMessageId) {
  try {
    await supabase
      .from('sms_log')
      .insert({ provider, phone, message, provider_message_id: providerMessageId ? String(providerMessageId) : null });
  } catch (err) {
    console.error('Failed to log sent SMS:', err);
  }
}

async function sendSMS(to, body) {
  if (SMS_PROVIDER === 'textmagic') {
    const response = await axios.post(
      'https://rest.textmagic.com/api/v2/messages',
      { text: body, phones: to },
      {
        auth: {
          username: process.env.TEXTMAGIC_USERNAME,
          password: process.env.TEXTMAGIC_TOKEN
        }
      }
    );
    console.log(`Textmagic SMS sent to ${to}:`, response.data);
    await logSmsSent('textmagic', to, body, response.data?.id);
    return response.data;
  } else {
    const msg = await twilioClient.messages.create({
      body,
      from: process.env.TWILIO_PHONE_NUMBER,
      to
    });
    console.log(`Twilio SMS sent to ${to}:`, msg.sid);
    await logSmsSent('twilio', to, body, msg.sid);
    return msg;
  }
}

async function getSetting(key, fallback) {
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', key)
    .single();
  return data?.value || fallback;
}

async function setSetting(key, value) {
  await supabase
    .from('settings')
    .upsert({ key, value }, { onConflict: 'key' });
}

function normalizePhone(phone) {
  if (!phone) return phone;
  const clean = String(phone).replace(/[^\d+]/g, '');
  if (clean.startsWith('+')) return clean;
  if (clean.startsWith('372')) return '+' + clean;
  return '+372' + clean.replace(/^0/, '');
}

const PRODUCT_VARIANTS = ['paikesepaneelid', 'akud', 'molemad'];

function detectProductType(extraInfo) {
  if (!extraInfo) return null;
  const match = extraInfo.match(/Soovib:\s*([^,]+)/i);
  if (!match) return null;
  const value = match[1].trim().toLowerCase();
  if (value.includes('mõlema') || value.includes('molema')) return 'molemad';
  if (value.includes('päikese') || value.includes('paikese')) return 'paikesepaneelid';
  if (value.includes('aku')) return 'akud';
  return null;
}

async function getProductTypeForConversation(conversationId) {
  const { data } = await supabase
    .from('leads')
    .select('extra_info')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1);
  return detectProductType(data?.[0]?.extra_info);
}

async function getSystemPrompt(productType) {
  if (productType) {
    const variant = await getSetting(`system_prompt_${productType}`, null);
    if (variant) return variant;
  }
  return await getSetting('system_prompt', 'Sa oled abivalmis assistent.');
}

const CONVERSATION_END_MARKER = '[VESTLUS_LOPETATUD]';

function withConversationEndInstruction(basePrompt) {
  return `${basePrompt}\n\nVESTLUSE LÕPETAMINE: Lisa oma vastuse kõige lõppu uuele reale täpselt see märgis: ${CONVERSATION_END_MARKER} kui KAS:\n1) oled läbinud ja saanud vastuse absoluutselt KÕIKIDELE ülalpool kirjeldatud küsimustele/sammudele (kui juhistes on nummerdatud punktid või kindel skript, pead olema läbinud need TÄIELIKULT, mitte ainult osa neist) ja lõpetad vestluse viisakalt (nt lubades, et spetsialist võtab peagi ühendust); VÕI\n2) klient on vaenulik, solvav, roppusi kasutav või agressiivne sinu või ettevõtte suhtes - sel juhul vasta lühidalt ja viisakalt (nt tänades aja eest) ja lõpeta vestlus kohe, ilma edasisi küsimusi esitamata.\nKui kasvõi üks samm veel punktist 1 on läbimata või vastamata ning klient pole vaenulik (punkt 2), ÄRA lisa märgist - esita hoopis järgmine puuduv küsimus. Ära lõpeta vestlust lihtsalt viisakusest või kuna klient tundub koostöövalmis - lõpeta ainult siis, kui kogu vajalik info on tegelikult kogutud, VÕI kui klient on vaenulik.\nÄra kunagi maini seda märgist ega selle sisu kliendile - see on ainult süsteemi jaoks ja eemaldatakse enne sõnumi saatmist.`;
}

function extractConversationEnd(reply) {
  if (reply.includes(CONVERSATION_END_MARKER)) {
    return { reply: reply.replaceAll(CONVERSATION_END_MARKER, '').trim(), ended: true };
  }
  return { reply, ended: false };
}

async function getFirstMessageTemplate(productType) {
  if (productType) {
    const variant = await getSetting(`first_message_template_${productType}`, null);
    if (variant) return variant;
  }
  return await getSetting('first_message_template', 'Tere, {name}.');
}

async function getBumpMessageTemplate(productType) {
  if (productType) {
    const variant = await getSetting(`bump_message_template_${productType}`, null);
    if (variant) return variant;
  }
  return await getSetting('bump_message_template', 'Tere {name}! Kas jõudsid mu eelmise sõnumiga tutvuda?');
}

function renderTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value || '');
  }
  return result;
}

async function createConversation(phoneNumber) {
  const { data: newConv } = await supabase
    .from('conversations')
    .insert({ phone_number: phoneNumber })
    .select()
    .single();
  return newConv;
}

async function getLatestConversation(phoneNumber) {
  const { data } = await supabase
    .from('conversations')
    .select('*')
    .eq('phone_number', phoneNumber)
    .order('created_at', { ascending: false })
    .limit(1);
  return data?.[0] || null;
}

async function getOrCreateConversation(phoneNumber) {
  const existing = await getLatestConversation(phoneNumber);
  if (existing) return existing;
  return await createConversation(phoneNumber);
}

async function getMessages(conversationId) {
  const { data } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  return data || [];
}

async function saveMessage(conversationId, role, content) {
  await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, role, content });
}

async function handleInboundSMS(from, text, res) {
  let conversation;
  try {
    from = normalizePhone(from);
    conversation = await getOrCreateConversation(from);
    await saveMessage(conversation.id, 'user', text);

    await supabase
      .from('leads')
      .update({ bump_sent: false, status: 'vestluses' })
      .eq('conversation_id', conversation.id);
  } catch (err) {
    console.error('Inbound SMS handler error:', err);
    return res.sendStatus(500);
  }

  res.sendStatus(200);

  if (conversation.ai_enabled === false) {
    console.log('AI disabled, skipping auto-reply');
    return;
  }

  try {
    const history = await getMessages(conversation.id);
    const chatHistory = history.map(m => ({ role: m.role, content: m.content }));
    const productType = await getProductTypeForConversation(conversation.id);
    const systemPrompt = withConversationEndInstruction(await getSystemPrompt(productType));
    const response = await openai.chat.completions.create({
      model: await getAiModel(),
      max_tokens: await getMaxResponseTokens(),
      messages: [{ role: 'system', content: systemPrompt }, ...chatHistory]
    });
    const { reply, ended } = extractConversationEnd(response.choices[0].message.content);
    await saveMessage(conversation.id, 'assistant', reply);
    if (ended) {
      await supabase.from('conversations').update({ ai_enabled: false }).eq('id', conversation.id);
      console.log(`AI marked conversation ${conversation.id} as finished`);
    }

    const replyDelaySeconds = parseInt(await getSetting('reply_delay_seconds', '0'));
    setTimeout(async () => {
      try {
        await sendSMS(from, reply);
        await supabase
          .from('leads')
          .update({ last_message_sent_at: new Date(), bump_sent: false })
          .eq('conversation_id', conversation.id);
        console.log('SMS sent successfully');
      } catch (err) {
        console.error('Delayed SMS send error:', err);
      }
    }, replyDelaySeconds * 1000);
  } catch (err) {
    console.error('AI reply generation error:', err);
  }
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const phoneNumberId = body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    if (!message || message.type !== 'text') {
      return res.sendStatus(200);
    }

    const from = message.from;
    const text = message.text.body;
    const conversation = await getOrCreateConversation(normalizePhone(from));
    await saveMessage(conversation.id, 'user', text);

    res.sendStatus(200);

    if (conversation.ai_enabled === false) {
      console.log('AI disabled, skipping WhatsApp auto-reply');
      return;
    }

    try {
      const history = await getMessages(conversation.id);
      const chatHistory = history.map(m => ({ role: m.role, content: m.content }));
      const productType = await getProductTypeForConversation(conversation.id);
      const systemPrompt = withConversationEndInstruction(await getSystemPrompt(productType));
      const response = await openai.chat.completions.create({
        model: await getAiModel(),
        max_tokens: await getMaxResponseTokens(),
        messages: [{ role: 'system', content: systemPrompt }, ...chatHistory]
      });
      const { reply, ended } = extractConversationEnd(response.choices[0].message.content);
      await saveMessage(conversation.id, 'assistant', reply);
      if (ended) {
        await supabase.from('conversations').update({ ai_enabled: false }).eq('id', conversation.id);
        console.log(`AI marked conversation ${conversation.id} as finished`);
      }

      const replyDelaySeconds = parseInt(await getSetting('reply_delay_seconds', '0'));
      setTimeout(async () => {
        try {
          await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: from,
              text: { body: reply }
            })
          });
          await supabase
            .from('leads')
            .update({ last_message_sent_at: new Date(), bump_sent: false })
            .eq('conversation_id', conversation.id);
        } catch (err) {
          console.error('Delayed WhatsApp send error:', err);
        }
      }, replyDelaySeconds * 1000);
    } catch (err) {
      console.error('WhatsApp reply generation error:', err);
    }
  } else {
    res.sendStatus(404);
  }
});

app.post('/sms-delivery', (req, res) => {
  console.log('Delivery notification received:', JSON.stringify(req.body));
  res.sendStatus(200);
});

app.post('/sms-textmagic', upload.none(), async (req, res) => {
  console.log('Textmagic inbound raw:', JSON.stringify(req.body));

  const from = req.body.from || req.body.phone || req.body.sender;
  const text = req.body.text || req.body.message || req.body.body;

  // Ignoreeri delivery notifikatsioone ja oma numbrit
  if (!text || req.body.status) return res.sendStatus(200);

  // Ignoreeri sõnumeid mis tulevad meie enda Textmagic numbrilt
  const textmagicPhone = (process.env.TEXTMAGIC_PHONE || '').replace(/\D/g, '');
  const fromClean = (from || '').replace(/\D/g, '');
  if (fromClean === textmagicPhone) {
    console.log('Ignoring message from own Textmagic number');
    return res.sendStatus(200);
  }

  console.log(`Textmagic SMS from ${from}: ${text}`);
  if (!from) return res.sendStatus(200);
  await handleInboundSMS(from, text, res);
});

app.get('/conversations', requireAuth, async (req, res) => {
  const { data } = await supabase
    .from('conversations')
    .select('*, messages(*), leads(name, email, status)')
    .order('created_at', { ascending: false });
  res.json(data);
});

app.post('/conversations/:id/toggle-ai', requireAuth, async (req, res) => {
  const { ai_enabled } = req.body;
  await supabase
    .from('conversations')
    .update({ ai_enabled })
    .eq('id', req.params.id);
  res.json({ success: true });
});

app.post('/conversations/:id/send', requireAuth, async (req, res) => {
  try {
    const { message } = req.body;
    const conversationId = req.params.id;

    const { data: conversation } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', conversationId)
      .single();

    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    await saveMessage(conversationId, 'assistant', message);
    await sendSMS(conversation.phone_number, message);

    await supabase
      .from('leads')
      .update({ last_message_sent_at: new Date(), bump_sent: false })
      .eq('conversation_id', conversationId);

    res.json({ success: true });
  } catch(err) {
    console.error('Manual send error:', err);
    res.sendStatus(500);
  }
});

app.get('/prompt', requireAuth, async (req, res) => {
  const prompt = await getSystemPrompt();
  const result = { prompt };
  for (const variant of PRODUCT_VARIANTS) {
    result[`prompt_${variant}`] = await getSetting(`system_prompt_${variant}`, '');
  }
  res.json(result);
});

app.post('/prompt', requireAuth, async (req, res) => {
  const { prompt } = req.body;
  if (prompt !== undefined) await setSetting('system_prompt', prompt);
  for (const variant of PRODUCT_VARIANTS) {
    const value = req.body[`prompt_${variant}`];
    if (value !== undefined) await setSetting(`system_prompt_${variant}`, value);
  }
  res.json({ success: true });
});

function isChatModel(id) {
  if (/embedding|whisper|tts|dall-e|moderation|davinci-002|babbage-002|realtime|audio|transcribe|image/i.test(id)) return false;
  return /^(gpt-|o1|o3|o4|chatgpt)/i.test(id);
}

async function getAiModel() {
  return await getSetting('ai_model', 'gpt-4o');
}

async function getMaxResponseTokens() {
  return parseInt(await getSetting('max_response_tokens', '150'));
}

app.get('/ai-models', requireAuth, async (req, res) => {
  try {
    const list = await openai.models.list();
    const models = list.data.map(m => m.id).filter(isChatModel).sort();
    res.json({ models });
  } catch (err) {
    console.error('Failed to list OpenAI models:', err);
    res.status(500).json({ models: [] });
  }
});

app.get('/test-chat/first-message', requireAuth, async (req, res) => {
  try {
    const productType = req.query.productType || null;
    const model = req.query.model || await getAiModel();
    const template = await getFirstMessageTemplate(productType);
    const message = renderTemplate(template, { name: 'Test' });

    const { data: testConv } = await supabase
      .from('test_conversations')
      .insert({ product_type: productType, model })
      .select()
      .single();
    await supabase.from('test_messages').insert({ test_conversation_id: testConv.id, role: 'assistant', content: message });

    res.json({ message, testConversationId: testConv.id });
  } catch (err) {
    console.error('Test chat first-message error:', err);
    res.sendStatus(500);
  }
});

app.post('/test-chat', requireAuth, async (req, res) => {
  try {
    const productType = req.body.productType || null;
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    const model = req.body.model || await getAiModel();
    const testConversationId = req.body.testConversationId || null;

    const lastMessage = messages[messages.length - 1];
    if (testConversationId && lastMessage?.role === 'user') {
      await supabase.from('test_messages').insert({ test_conversation_id: testConversationId, role: 'user', content: lastMessage.content });
    }

    const systemPrompt = withConversationEndInstruction(await getSystemPrompt(productType));
    const response = await openai.chat.completions.create({
      model,
      max_tokens: await getMaxResponseTokens(),
      messages: [{ role: 'system', content: systemPrompt }, ...messages]
    });
    const { reply, ended } = extractConversationEnd(response.choices[0].message.content);

    if (testConversationId) {
      await supabase.from('test_messages').insert({ test_conversation_id: testConversationId, role: 'assistant', content: reply });
      if (ended) await supabase.from('test_conversations').update({ ended: true }).eq('id', testConversationId);
    }

    res.json({ reply, ended });
  } catch (err) {
    console.error('Test chat error:', err);
    res.sendStatus(500);
  }
});

app.get('/test-conversations', requireAuth, async (req, res) => {
  const { data } = await supabase
    .from('test_conversations')
    .select('*, test_messages(*)')
    .order('created_at', { ascending: false })
    .limit(50);
  res.json(data);
});

app.get('/templates', requireAuth, async (req, res) => {
  const firstMessage = await getSetting('first_message_template', 'Tere, {name}.');
  const bumpMessage = await getSetting('bump_message_template', 'Tere {name}! Kas jõudsid mu eelmise sõnumiga tutvuda?');
  const noResponseDelay = await getSetting('no_response_delay_seconds', '3600');
  const firstMessageDelay = await getSetting('first_message_delay_seconds', '0');
  const replyDelay = await getSetting('reply_delay_seconds', '0');
  const aiModel = await getAiModel();
  const maxResponseTokens = await getMaxResponseTokens();
  const result = {
    first_message_template: firstMessage,
    bump_message_template: bumpMessage,
    no_response_delay_seconds: parseInt(noResponseDelay),
    first_message_delay_seconds: parseInt(firstMessageDelay),
    reply_delay_seconds: parseInt(replyDelay),
    ai_model: aiModel,
    max_response_tokens: maxResponseTokens
  };
  for (const variant of PRODUCT_VARIANTS) {
    result[`first_message_template_${variant}`] = await getSetting(`first_message_template_${variant}`, '');
    result[`bump_message_template_${variant}`] = await getSetting(`bump_message_template_${variant}`, '');
  }
  res.json(result);
});

app.post('/templates', requireAuth, async (req, res) => {
  const { first_message_template, bump_message_template, no_response_delay_seconds, first_message_delay_seconds, reply_delay_seconds, ai_model, max_response_tokens } = req.body;
  if (first_message_template !== undefined) await setSetting('first_message_template', first_message_template);
  if (bump_message_template !== undefined) await setSetting('bump_message_template', bump_message_template);
  if (no_response_delay_seconds !== undefined) await setSetting('no_response_delay_seconds', String(no_response_delay_seconds));
  if (first_message_delay_seconds !== undefined) await setSetting('first_message_delay_seconds', String(first_message_delay_seconds));
  if (reply_delay_seconds !== undefined) await setSetting('reply_delay_seconds', String(reply_delay_seconds));
  if (ai_model !== undefined) await setSetting('ai_model', ai_model);
  if (max_response_tokens !== undefined) await setSetting('max_response_tokens', String(max_response_tokens));
  for (const variant of PRODUCT_VARIANTS) {
    const firstVariant = req.body[`first_message_template_${variant}`];
    if (firstVariant !== undefined) await setSetting(`first_message_template_${variant}`, firstVariant);
    const bumpVariant = req.body[`bump_message_template_${variant}`];
    if (bumpVariant !== undefined) await setSetting(`bump_message_template_${variant}`, bumpVariant);
  }
  res.json({ success: true });
});

app.post('/lead', async (req, res) => {
  try {
    console.log('RAW BODY:', JSON.stringify(req.body));

    const name = req.body['Täisnimi'] || req.body['name'] || req.body['Nimi'];
    const email = req.body['E-post'] || req.body['Email'] || req.body['email'] || '';
    const phone = req.body['Telefon'] || req.body['telf'];
    const address = req.body['Aadress'] || req.body['field_edac53c'] || '';
    const clientType = req.body['Soovin päikesepaneele/akut:'] || req.body['field_38b7809'] || req.body['Klienditüüp'] || '';
    const productType = req.body['Kas soovid päikesepaneele, akut või mõlemat?'] || req.body['field_c671f4d'] || '';
    const installationType = req.body['Kas soovite maa- või katusepaigaldust?'] || req.body['field_d3194c1'] || '';
    const roofType = req.body['Kas tegemist on viil- või lamekatusega?'] || req.body['field_b4f31ef'] || '';
    const companyName = req.body['Ettevõtte nimi'] || '';
    const extraInfo = req.body['Lisainfo'] || '';

    const extra_info = [
      productType ? `Soovib: ${productType}` : '',
      installationType ? `Paigaldus: ${installationType}` : '',
      roofType ? `Katus: ${roofType}` : '',
      address ? `Aadress: ${address}` : '',
      companyName ? `Ettevõte: ${companyName}` : '',
      extraInfo ? `Lisainfo: ${extraInfo}` : ''
    ].filter(Boolean).join(', ');

    console.log(`New lead: ${name} (${phone}) - ${clientType} - ${extra_info}`);

    if (!phone) {
      console.error('No phone number provided');
      return res.sendStatus(400);
    }

    const cleanPhone = normalizePhone(phone);

    const { data: lead } = await supabase
      .from('leads')
      .insert({ name, email, phone: cleanPhone, client_type: clientType, extra_info, status: 'uus' })
      .select()
      .single();

    const conversation = await createConversation(cleanPhone);
    await supabase
      .from('leads')
      .update({ conversation_id: conversation.id })
      .eq('id', lead.id);

    const firstMessageDelaySeconds = parseInt(await getSetting('first_message_delay_seconds', '0'));
    res.sendStatus(200);

    setTimeout(async () => {
      try {
        const firstName = name ? name.split(' ')[0] : '';
        const detectedProductType = detectProductType(extra_info);
        const firstMessageTemplate = await getFirstMessageTemplate(detectedProductType);
        const reply = renderTemplate(firstMessageTemplate, { name: firstName });

        await saveMessage(conversation.id, 'assistant', reply);
        await sendSMS(cleanPhone, reply);

        await supabase
          .from('leads')
          .update({ status: 'vestluses', last_message_sent_at: new Date() })
          .eq('id', lead.id);

        console.log('First SMS sent to lead');
      } catch (err) {
        console.error('Delayed first SMS error:', err);
      }
    }, firstMessageDelaySeconds * 1000);
  } catch(err) {
    console.error('Lead handler error:', err);
    res.sendStatus(500);
  }
});

app.get('/leads', requireAuth, async (req, res) => {
  const { data } = await supabase
    .from('leads')
    .select('*, conversations(*, messages(*))')
    .order('created_at', { ascending: false });
  res.json(data);
});

app.post('/leads/:id/status', requireAuth, async (req, res) => {
  const { status } = req.body;
  await supabase
    .from('leads')
    .update({ status })
    .eq('id', req.params.id);
  res.json({ success: true });
});

app.get('/settings/bump-delay', requireAuth, async (req, res) => {
  const seconds = await getSetting('bump_delay_seconds', '3600');
  res.json({ seconds: parseInt(seconds) });
});

app.post('/settings/bump-delay', requireAuth, async (req, res) => {
  const { seconds } = req.body;
  await setSetting('bump_delay_seconds', String(seconds));
  res.json({ success: true });
});

app.post('/sms', async (req, res) => {
  const from = req.body.From;
  const text = req.body.Body;
  console.log(`SMS from ${from}: ${text}`);
  if (!from || !text) return res.sendStatus(200);
  await handleInboundSMS(from, text, res);
});

const PORT = process.env.PORT || 3000;

app.get('/cron/check-bumps', async (req, res) => {
  try {
    const bumpDelaySeconds = parseInt(await getSetting('bump_delay_seconds', '3600'));
    const noResponseDelaySeconds = parseInt(await getSetting('no_response_delay_seconds', '3600'));

    const now = new Date();
    let bumpedCount = 0;
    let noResponseCount = 0;

    const { data: pendingLeads } = await supabase
      .from('leads')
      .select('*, conversations(ai_enabled)')
      .eq('status', 'vestluses')
      .eq('bump_sent', false);

    for (const lead of (pendingLeads || [])) {
      if (!lead.last_message_sent_at) continue;
      if (lead.conversations && lead.conversations.ai_enabled === false) continue;
      const secondsSince = (now - new Date(lead.last_message_sent_at)) / 1000;
      if (secondsSince >= bumpDelaySeconds) {
        const firstName = lead.name ? lead.name.split(' ')[0] : '';
        const productType = detectProductType(lead.extra_info);
        const bumpMessageTemplate = await getBumpMessageTemplate(productType);
        const bumpMessage = renderTemplate(bumpMessageTemplate, { name: firstName });
        await sendSMS(lead.phone, bumpMessage);
        if (lead.conversation_id) await saveMessage(lead.conversation_id, 'assistant', bumpMessage);
        await supabase.from('leads').update({ bump_sent: true }).eq('id', lead.id);
        bumpedCount++;
        console.log(`Bump sent to ${lead.phone}`);
      }
    }

    const { data: bumpedLeads } = await supabase
      .from('leads')
      .select('*, conversations(ai_enabled)')
      .eq('status', 'vestluses')
      .eq('bump_sent', true);

    for (const lead of (bumpedLeads || [])) {
      if (!lead.last_message_sent_at) continue;
      if (lead.conversations && lead.conversations.ai_enabled === false) continue;
      const secondsSinceBump = (now - new Date(lead.last_message_sent_at)) / 1000 - bumpDelaySeconds;
      if (secondsSinceBump >= noResponseDelaySeconds) {
        await supabase.from('leads').update({ status: 'ei vastanud' }).eq('id', lead.id);
        noResponseCount++;
        console.log(`Marked as no response: ${lead.phone}`);
      }
    }

    res.json({ bumped: bumpedCount, marked_no_response: noResponseCount });
  } catch(err) {
    console.error('Cron bump error:', err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));