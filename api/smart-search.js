// api/smart-search.js
const OpenAI = require('openai');
const deepl = require('deepl-node'); // <<< AGGIUNTO IMPORT >>>

// Configura la chiave API di OpenRouter
const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

// Configura la chiave API di DeepL (per la traduzione)
// È essenziale che questa sia una variabile d'ambiente su Vercel!
const translator = new deepl.Translator(process.env.DEEPL_API_KEY); // <<< AGGIUNTO >>>

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://localmente-v3-core.web.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let { userQuery, relevantData } = req.body; // relevantData sarà vuoto all'inizio

  if (!userQuery) {
    return res.status(400).json({ error: 'Missing userQuery in request body.' });
  }

  // <<< INIZIO: FASE DI TRADUZIONE CON DEEPL >>>
  let translatedQuery = userQuery;
  try {
      // DeepL rileva automaticamente la lingua sorgente e traduce in italiano
      const result = await translator.translateText(userQuery, null, 'it');
      translatedQuery = result.text;
      console.log(`Original: "${userQuery}" -> Translated: "${translatedQuery}"`);
  } catch (translateError) {
      console.error('DeepL Translation Error:', translateError);
      // Continua con la query originale se la traduzione fallisce
      translatedQuery = userQuery;
  }
  // <<< FINE: FASE DI TRADUZIONE >>>

  // --- Qui, relevantData è ancora vuoto. Verrà popolato dalla SmartSearchService Flutter.
  // Dobbiamo passare la translatedQuery al modello AI. ---


  const systemPrompt = `Sei un assistente di ricerca intelligente e amichevole per una piattaforma e-commerce locale chiamata "Localmente".
  Il tuo compito è aiutare gli utenti a trovare prodotti, servizi e attività commerciali disponibili nel nostro database.
  Devi sempre e solo basare le tue risposte sui "relevantData" che ti vengono forniti.
  Non inventare informazioni. Se la query dell'utente non trova riscontro nei "relevantData" forniti, rispondi in modo conciso e amichevole che non hai trovato risultati specifici e suggerisci di provare altri termini o filtri.
  La tua risposta deve essere concisa, utile, in italiano fluente e orientata all'azione.
  Se trovi risultati, descrivili brevemente e fai riferimento al fatto che l'utente potrà cliccare per vederli i dettagli, con un tono di voce positivo e disponibile.
  Evita lunghe spiegazioni, saluti o risposte filosofiche. Vai dritto al punto.
  Non rispondere a domande generiche non correlate al nostro database di prodotti/servizi (es. barzellette, politica, meteo, calcoli matematici). In quel caso, dì che non puoi aiutare con quella richiesta ma sei felice di aiutare con la ricerca di prodotti e servizi locali.`;

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
      temperature: 0.5, // Leggermente meno "creativa" per maggiore fedeltà ai dati
      max_tokens: 200,
    });

    const aiResponse = completion.choices[0].message.content;
    res.status(200).json({ aiResponse, translatedQuery }); // <<< AGGIUNTO translatedQuery ALLA RISPOSTA >>>

  } catch (error) {
    console.error('Error calling OpenRouter AI:', error);
    res.status(500).json({ error: 'Failed to get AI response', details: error.message });
  }
};
