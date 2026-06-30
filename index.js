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

async function getSystemPrompt() {
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'system_prompt')
    .single();
  return data?.value || 'Sa oled abivalmis assistent.';
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

app.get('/prompt', async (req, res) => {
  const prompt = await getSystemPrompt();
  res.json({ prompt });
});

app.post('/prompt', async (req, res) => {
  const { prompt } = req.body;
  await supabase
    .from('settings')
    .update({ value: prompt, updated_at: new Date() })
    .eq('key', 'system_prompt');
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
    const reply = `Tere, ${firstName}, Rait, Naps Solar OÜ-st siinpool. Täitsid Facebookis meie päringuvormi. Kas tohin paar küsimust küsida?`;

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
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'bump_delay_seconds')
    .single();
  res.json({ seconds: parseInt(data?.value || '3600') });
});

app.post('/settings/bump-delay', async (req, res) => {
  const { seconds } = req.body;
  await supabase
    .from('settings')
    .update({ value: String(seconds) })
    .eq('key', 'bump_delay_seconds');
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

    await supabase
      .from('leads')
      .update({ last_message_sent_at: new Date(), bump_sent: false })
      .eq('conversation_id', conversation.id);

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
    const { data: settingData } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'bump_delay_seconds')
      .single();
    const bumpDelaySeconds = parseInt(settingData?.value || '3600');

    const { data: leads } = await supabase
      .from('leads')
      .select('*')
      .eq('status', 'vestluses')
      .eq('bump_sent', false);

    if (!leads || leads.length === 0) {
      return res.json({ checked: 0, bumped: 0 });
    }

    let bumpedCount = 0;
    const now = new Date();

    for (const lead of leads) {
      if (!lead.last_message_sent_at) continue;

      const lastSent = new Date(lead.last_message_sent_at);
      const secondsSince = (now - lastSent) / 1000;

      if (secondsSince >= bumpDelaySeconds) {
        const bumpMessage = `Tere ${lead.name ? lead.name.split(' ')[0] : ''}! Kas jõudsid mu eelmise sõnumiga tutvuda? Olen siin, kui on küsimusi.`;

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

    res.json({ checked: leads.length, bumped: bumpedCount });
  } catch(err) {
    console.error('Cron bump error:', err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));