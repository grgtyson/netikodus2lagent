require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const SYSTEM_PROMPT = `Sa oled Netikodu polsterduse puhastuse assistent. Sinu ülesanne on kvalifitseerida klienti järgmiste küsimustega ükshaaval:
1. Mis mööblit soovite puhastada? (diivan, tool, auto, muu)
2. Kui suur see on? (mitu istekohta või suurus)
3. Mis materjalist see on? (kangas, nahk, muu)
4. Mis on teie asukoht?
5. Millal sooviksite teenust?

Küsi üks küsimus korraga. Ole sõbralik ja professionaalne. Vasta alati eesti keeles. Kui klient küsib midagi teenuse kohta, vasta lühidalt ja jätka kvalifitseerimisega.`;

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

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
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

      console.log(`Message from ${from}: ${text}`);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));