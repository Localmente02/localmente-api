// api/gift-recommender.js
// VERSIONE 2.0 - FORNITORE DI DATI PER LA CACHE UNIVERSALE
// Questo cervello non fa più calcoli. Il suo unico scopo è scaricare
// TUTTI i documenti rilevanti da Firebase e passarli all'app.

const OpenAI = require('openai');
const translate = require('@iamtraction/google-translate');

// Configura la chiave API di OpenRouter
const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

module.exports = async (req, res) => {
  // Impostazioni CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://localmente-v3-core.web.app'); // Sostituisci con l'URL della tua web app se diverso
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let { userQuery, relevantData } = req.body;

  if (!userQuery) {
    return res.status(400).json({ error: 'Missing userQuery in request body.' });
  }

  let translatedQuery = userQuery;
  try {
      const result = await translate(userQuery, { to: 'it' });
      translatedQuery = result.text;
      console.log(`Original Query: "${userQuery}" -> Translated to Italian: "${translatedQuery}"`);
  } catch (translateError) {
      console.error('Error during free translation:', translateError);
      translatedQuery = userQuery;
  }

  // <<< INIZIO: SYSTEM PROMPT RAFFINATO PER UN TONO AMICHEVOLE E CONSIGLI >>>
  const systemPrompt = `Sei un assistente di ricerca intelligente e **molto amichevole** per una piattaforma e-commerce locale chiamata "Localmente".
  Il tuo compito è aiutare gli utenti a trovare prodotti, servizi e attività commerciali disponibili nel nostro database.
  Quando l'utente chiede consigli o suggerimenti (es. "cosa mi consigli?", "scarpe per...", "idee regalo per..."), rispondi con un tono proattivo e disponibile, come un vero commesso esperto che offre consigli.
  **Inizia sempre con un saluto caldo e una frase incoraggiante come "Ciao! Ho un sacco di idee per te!" o "Che bella ricerca! Ecco cosa ho trovato..." o "Ciao! Sono felice di darti qualche consiglio!".**
  Devi sempre e solo basare le tue risposte sui "relevantData" che ti vengono forniti.
  Non inventare informazioni. Se la query dell'utente non trova riscontro nei "relevantData" forniti, rispondi in modo conciso e amichevole che non hai trovato risultati specifici e suggerisci di provare altri termini o filtri.
  La tua risposta deve essere concisa, utile, in italiano fluente e orientata all'azione.
  Se trovi risultati, descrivili brevemente e fai riferimento al fatto che l'utente potrà cliccare per vederli i dettagli, con un tono di voce positivo e disponibile.
  Evita lunghe spiegazioni, saluti o risposte filosofiche. Vai dritto al punto.
  Non rispondere a domande generiche non correlate al nostro database di prodotti/servizi (es. barzellette, politica, meteo, calcoli matematici). In quel caso, dì che non puoi aiutare con quella richiesta ma sei felice di aiutare con la ricerca di prodotti e servizi locali.`;
  // <<< FINE: SYSTEM PROMPT RAFFINATO >>>

  let relevantDataMessage = "";
  if (relevantData && relevantData.length > 0) {
      relevantDataMessage = `Ecco i dati rilevanti trovati nel nostro database (formato JSON): ${JSON.stringify(relevantData)}.`;
  } else {
      relevantDataMessage = `Non sono stati trovati dati rilevanti nel nostro database per questa query.`;
  }

  const userMessage = `Ecco la query dell'utente (già tradotta in italiano se necessario): "${translatedQuery}".
  ${relevantDataMessage}
  Genera una risposta naturale e utile, utilizzando solo questi dati per spiegare cosa hai trovato, oppure indicando che non ci sono risultati specifici.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "mistralai/mistral-7b-instruct",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.7, // Aumentato leggermente per risposte più "vivaci" ma ancora coerenti
      max_tokens: 200,
    });

    const aiResponse = completion.choices[0].message.content;
    res.status(200).json({ aiResponse, translatedQuery });

  } catch (error) {
    console.error('Error calling OpenRouter AI:', error);
    res.status(500).json({ error: 'Failed to get AI response', details: error.message });
  }
};
