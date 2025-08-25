// api/smart-search.js
const OpenAI = require('openai'); // Assicurati di avere 'openai' installato nel tuo progetto Vercel (npm install openai)

// Configura la chiave API di OpenRouter (o OpenAI, se la usi direttamente)
// È essenziale che questa sia una variabile d'ambiente sul progetto Vercel!
// Ad esempio: OPENROUTER_API_KEY
const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1", // Questo è l'endpoint di OpenRouter
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { userQuery, relevantData } = req.body;

  if (!userQuery || !relevantData) {
    return res.status(400).json({ error: 'Missing userQuery or relevantData in request body.' });
  }

  // Istruzioni per l'AI: costruisci il "System Prompt"
  // Questo dice all'AI come deve comportarsi e a cosa dare priorità.
  const systemPrompt = `Sei un assistente di ricerca intelligente per una piattaforma e-commerce locale chiamata "Localmente".
  Il tuo compito è aiutare gli utenti a trovare prodotti, servizi e attività commerciali disponibili nel nostro database.
  Devi sempre e solo basare le tue risposte sui "relevantData" che ti vengono forniti.
  Non inventare informazioni. Se la query dell'utente non trova riscontro nei "relevantData", rispondi che non hai trovato risultati specifici e suggerisci di provare altri termini.
  La tua risposta deve essere concisa, utile, in italiano fluente e orientata all'azione.
  Se trovi risultati, descrivili brevemente e fai riferimento al fatto che l'utente potrà cliccare per vederli.
  Evita lunghe spiegazioni, saluti o risposte filosofiche. Vai dritto al punto.
  Non rispondere a domande generiche non correlate al nostro database di prodotti/servizi (es. barzellette, politica, meteo, calcoli matematici). In quel caso, dì che non puoi aiutare con quella richiesta.`;

  // Costruisci il "User Prompt" con la query dell'utente e i dati rilevanti
  const userMessage = `Ecco la query dell'utente: "${userQuery}".
  Ecco i dati rilevanti trovati nel nostro database (formato JSON): ${JSON.stringify(relevantData)}.
  Genera una risposta naturale e utile, utilizzando solo questi dati per spiegare cosa hai trovato.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "mistralai/mistral-7b-instruct", // Puoi provare altri modelli come "gpt-3.5-turbo" o altri disponibili su OpenRouter
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.7, // Controlla la "creatività" dell'AI (0.0 è molto meno creativa)
      max_tokens: 300,  // Limita la lunghezza della risposta per risparmiare token e essere concisi
    });

    const aiResponse = completion.choices[0].message.content;
    res.status(200).json({ aiResponse });

  } catch (error) {
    console.error('Error calling OpenRouter AI:', error);
    res.status(500).json({ error: 'Failed to get AI response', details: error.message });
  }
};
