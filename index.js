require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(__dirname));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

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

async function getSystemPrompt() {
  return await getSetting('system_prompt', 'Sa oled abivalmis assistent.');
}

function renderTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value || '');
  }
  return result;
}

async function getOrCreateConversation(phoneNumber) {
  let { data } = await supabase
    .from('conversations')
    .select('*')
    .eq('phone_number', phoneNumber)
    .single();
  if (!data) {
    const { data: newConv } = await supabase
      .from('conversations')
      .insert({ phone_number: phoneNumber })
      .select()
      .single();
    data = newConv;
  }
  return data;
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
    if (message && message.type === 'text') {
      const from = message.from;
      const text = message.text.body;
      const conversation = await getOrCreateConversation(from);
      await saveMessage(conversation.id, 'user', text);
      const history = await getMessages(conversation.id);
      const chatHistory = history.map(m => ({ role: m.role, content: m.content }));
      const systemPrompt = await getSystemPrompt();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          ...chatHistory
        ]
      });
      const reply = response.choices[0].message.content;
      await saveMessage(conversation.id, 'assistant', reply);
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
      console.log(`WhatsApp from ${from}: ${text}`);
      console.log(`AI reply: ${reply}`);
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

app.get('/conversations', async (req, res) => {
  const { data } = await supabase
    .from('conversations')
    .select('*, messages(*)')
    .order('created_at', { ascending: false });
  res.json(data);
});

app.post('/conversations/:id/toggle-ai', async (req, res) => {
  const { ai_enabled } = req.body;
  await supabase
    .from('conversations')
    .update({ ai_enabled })
    .eq('id', req.params.id);
  res.json({ success: true });
});

app.post('/conversations/:id/send', async (req, res) => {
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

    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: conversation.phone_number
    });

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

app.get('/prompt', async (req, res) => {
  const prompt = await getSystemPrompt();
  res.json({ prompt });
});

app.post('/prompt', async (req, res) => {
  const { prompt } = req.body;
  await setSetting('system_prompt', prompt);
  res.json({ success: true });
});

app.get('/templates', async (req, res) => {
  const firstMessage = await getSetting('first_message_template', 'Tere, {name}.');
  const bumpMessage = await getSetting('bump_message_template', 'Tere {name}! Kas jõudsid mu eelmise sõnumiga tutvuda?');
  const noResponseDelay = await getSetting('no_response_delay_seconds', '3600');
  res.json({
    first_message_template: firstMessage,
    bump_message_template: bumpMessage,
    no_response_delay_seconds: parseInt(noResponseDelay)
  });
});

app.post('/templates', async (req, res) => {
  const { first_message_template, bump_message_template, no_response_delay_seconds } = req.body;
  if (first_message_template !== undefined) await setSetting('first_message_template', first_message_template);
  if (bump_message_template !== undefined) await setSetting('bump_message_template', bump_message_template);
  if (no_response_delay_seconds !== undefined) await setSetting('no_response_delay_seconds', String(no_response_delay_seconds));
  res.json({ success: true });
});

app.post('/lead', async (req, res) => {
  try {
    console.log('RAW BODY:', JSON.stringify(req.body));

    const name = req.body['Nimi'];
    const phone = req.body['Telefon'];
    const client_type = req.body['Klienditüüp'];
    const extra_info = req.body['Lisainfo'];

    console.log(`New lead: ${name} (${phone}) - ${client_type}`);

    let cleanPhone = phone.replace(/\s+/g, '');
    if (!cleanPhone.startsWith('+')) {
      cleanPhone = '+372' + cleanPhone.replace(/^0/, '');
    }

    const { data: lead } = await supabase
      .from('leads')
      .insert({
        name,
        phone: cleanPhone,
        client_type,
        extra_info,
        status: 'uus'
      })
      .select()
      .single();

    const conversation = await getOrCreateConversation(cleanPhone);
    await supabase
      .from('leads')
      .update({ conversation_id: conversation.id })
      .eq('id', lead.id);

    const firstName = name.split(' ')[0];
    const firstMessageTemplate = await getSetting('first_message_template', 'Tere, {name}.');
    const reply = renderTemplate(firstMessageTemplate, { name: firstName });

    await saveMessage(conversation.id, 'assistant', reply);

    await twilioClient.messages.create({
      body: reply,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: cleanPhone
    });

    await supabase
      .from('leads')
      .update({
        status: 'vestluses',
        last_message_sent_at: new Date()
      })
      .eq('id', lead.id);

    console.log('First SMS sent to lead');
    res.sendStatus(200);
  } catch(err) {
    console.error('Lead handler error:', err);
    res.sendStatus(500);
  }
});

app.get('/leads', async (req, res) => {
  const { data } = await supabase
    .from('leads')
    .select('*, conversations(*, messages(*))')
    .order('created_at', { ascending: false });
  res.json(data);
});

app.post('/leads/:id/status', async (req, res) => {
  const { status } = req.body;
  await supabase
    .from('leads')
    .update({ status })
    .eq('id', req.params.id);
  res.json({ success: true });
});

app.get('/settings/bump-delay', async (req, res) => {
  const seconds = await getSetting('bump_delay_seconds', '3600');
  res.json({ seconds: parseInt(seconds) });
});

app.post('/settings/bump-delay', async (req, res) => {
  const { seconds } = req.body;
  await setSetting('bump_delay_seconds', String(seconds));
  res.json({ success: true });
});

app.post('/sms', async (req, res) => {
  const from = req.body.From;
  const text = req.body.Body;
  console.log(`SMS from ${from}: ${text}`);
  try {
    const conversation = await getOrCreateConversation(from);
    console.log(`Conversation ID: ${conversation.id}`);

    await saveMessage(conversation.id, 'user', text);
    console.log('User message saved');

    await supabase
      .from('leads')
      .update({ last_message_sent_at: new Date(), bump_sent: false, status: 'vestluses' })
      .eq('conversation_id', conversation.id);

    if (conversation.ai_enabled === false) {
      console.log('AI disabled for this conversation, skipping auto-reply');
      return res.sendStatus(200);
    }

    const history = await getMessages(conversation.id);
    const chatHistory = history.map(m => ({ role: m.role, content: m.content }));
    const systemPrompt = await getSystemPrompt();
    console.log(`History length: ${chatHistory.length}`);
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...chatHistory
      ]
    });
    const reply = response.choices[0].message.content;
    console.log(`AI reply: ${reply}`);

    await saveMessage(conversation.id, 'assistant', reply);

    await twilioClient.messages.create({
      body: reply,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: from
    });

    console.log('SMS sent successfully');
    res.sendStatus(200);
  } catch(err) {
    console.error('SMS handler error:', err);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;

app.get('/cron/check-bumps', async (req, res) => {
  try {
    const bumpDelaySeconds = parseInt(await getSetting('bump_delay_seconds', '3600'));
    const noResponseDelaySeconds = parseInt(await getSetting('no_response_delay_seconds', '3600'));
    const bumpMessageTemplate = await getSetting('bump_message_template', 'Tere {name}! Kas jõudsid mu eelmise sõnumiga tutvuda?');

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
        const bumpMessage = renderTemplate(bumpMessageTemplate, { name: firstName });

        await twilioClient.messages.create({
          body: bumpMessage,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: lead.phone
        });

        if (lead.conversation_id) {
          await saveMessage(lead.conversation_id, 'assistant', bumpMessage);
        }

        await supabase
          .from('leads')
          .update({ bump_sent: true })
          .eq('id', lead.id);

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
        await supabase
          .from('leads')
          .update({ status: 'ei vastanud' })
          .eq('id', lead.id);

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