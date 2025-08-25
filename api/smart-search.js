// api/smart-search.js
const OpenAI = require('openai');

// Configura la chiave API di OpenRouter
// Questa chiave sarà letta dalle variabili d'ambiente di Vercel.
const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY, // Il nome della variabile d'ambiente su Vercel
  baseURL: "https://openrouter.ai/api/v1",
});

module.exports = async (req, res) => {
  // Impostazioni CORS per permettere all'app Flutter di chiamare questa funzione
  res.setHeader('Access-Control-Allow-Origin', 'https://localmente-v3-core.web.app'); // Sostituisci con l'URL della tua web app se diverso
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    // Risponde pre-flight CORS
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { userQuery, relevantData } = req.body;

  if (!userQuery) {
    return res.status(400).json({ error: 'Missing userQuery in request body.' });
  }
  // relevantData può essere vuoto, l'AI sarà istruita a gestire questo.

  // Istruzioni per l'AI: costruisci il "System Prompt"
  const systemPrompt = `Sei un assistente di ricerca intelligente e amichevole per una piattaforma e-commerce locale chiamata "Localmente".
  Il tuo compito è aiutare gli utenti a trovare prodotti, servizi e attività commerciali disponibili nel nostro database.
  Devi sempre e solo basare le tue risposte sui "relevantData" che ti vengono forniti.
  Non inventare informazioni. Se la query dell'utente non trova riscontro nei "relevantData" forniti, rispondi in modo conciso e amichevole che non hai trovato risultati specifici e suggerisci di provare altri termini o filtri.
  La tua risposta deve essere concisa, utile, in italiano fluente e orientata all'azione.
  Se trovi risultati, descrivili brevemente e fai riferimento al fatto che l'utente potrà cliccare per vederli i dettagli, con un tono di voce positivo e disponibile.
  Evita lunghe spiegazioni, saluti o risposte filosofiche. Vai dritto al punto.
  Non rispondere a domande generiche non correlate al nostro database di prodotti/servizi (es. barzellette, politica, meteo, calcoli matematici). In quel caso, dì che non puoi aiutare con quella richiesta ma sei felice di aiutare con la ricerca di prodotti e servizi locali.`;

  // Costruisci il "User Prompt" con la query dell'utente e i dati rilevanti
  // Includiamo un messaggio se relevantData è vuoto.
  let relevantDataMessage = "";
  if (relevantData && relevantData.length > 0) {
      relevantDataMessage = `Ecco i dati rilevanti trovati nel nostro database (formato JSON): ${JSON.stringify(relevantData)}.`;
  } else {
      relevantDataMessage = `Non sono stati trovati dati rilevanti nel nostro database per questa query.`;
  }

  const userMessage = `Ecco la query dell'utente: "${userQuery}".
  ${relevantDataMessage}
  Genera una risposta naturale e utile, utilizzando solo questi dati per spiegare cosa hai trovato, oppure indicando che non ci sono risultati specifici.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "mistralai/mistral-7b-instruct", // Modello consigliato su OpenRouter per costi e prestazioni
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.7, // Mantiene l'AI creativa ma non troppo "fuori tema"
      max_tokens: 200,  // Limita la lunghezza della risposta
    });

    const aiResponse = completion.choices[0].message.content;
    res.status(200).json({ aiResponse });

  } catch (error) {
    console.error('Error calling OpenRouter AI:', error);
    res.status(500).json({ error: 'Failed to get AI response', details: error.message });
  }
};
