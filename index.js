require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const conversations = {};

const SYSTEM_PROMPT = `Sa oled Netikodu polsterduse puhastuse assistent. Sinu ülesanne on kvalifitseerida klienti järgmiste küsimustega ükshaaval:
1. Mis mööblit soovite puhastada? (diivan, tool, auto, muu)
2. Kui suur see on? (mitu istekohta või suurus)
3. Mis materjalist see on? (kangas, nahk, muu)
4. Mis on teie asukoht?
5. Millal sooviksite teenust?

Küsi üks küsimus korraga. Ole sõbralik ja professionaalne. Vasta alati eesti keeles. Kui klient küsib midagi teenuse kohta, vasta lühidalt ja jätka kvalifitseerimisega.`;

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

      if (!conversations[from]) {
        conversations[from] = [];
      }

      conversations[from].push({ role: 'user', content: text });

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...conversations[from]
        ]
      });

      const reply = response.choices[0].message.content;
      conversations[from].push({ role: 'assistant', content: reply });

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
    }

    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));