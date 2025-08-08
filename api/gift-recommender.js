// api/gift-recommender.js

const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- CONFIGURAZIONE ---
// Inizializza Firebase Admin SDK
// Usa le credenziali che hai messo nelle Environment Variables di Vercel
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
  });
}
const db = admin.firestore();

// Inizializza Google Gemini
// Usa la API Key che hai messo nelle Environment Variables di Vercel
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-pro' });


// --- FUNZIONE PRINCIPALE ---
module.exports = async (req, res) => {
  // Imposta header per CORS (per permettere all'app di chiamare l'API)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non consentito' });
  }

  try {
    const userPreferences = req.body;

    // 1. Recupera i prodotti da Firebase
    const productsSnapshot = await db.collection('global_product_catalog').limit(100).get(); // Limite per non eccedere
    if (productsSnapshot.empty) {
      return res.status(404).json({ error: 'Nessun prodotto nel catalogo.' });
    }
    const allProducts = productsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    let suggestions = [];
    
    try {
        // 2. Prepara il prompt per l'AI
        const prompt = createPrompt(userPreferences, allProducts);
        
        // 3. Chiama l'AI
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        
        // 4. Interpreta la risposta
        // Rimuovi eventuali ```json e ``` finali per sicurezza
        const cleanJsonString = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const aiSuggestions = JSON.parse(cleanJsonString);

        if (aiSuggestions && aiSuggestions.length > 0) {
            // Arricchisci i suggerimenti AI con i dati completi (es. imageUrl)
            suggestions = aiSuggestions.map(aiSugg => {
                const fullProduct = allProducts.find(p => p.id === aiSugg.id);
                return {
                    ...fullProduct, // Contiene già id, name, price, imageUrl, etc.
                    aiExplanation: aiSugg.aiExplanation || "Un'ottima scelta basata sulle tue preferenze."
                };
            });
        }
    } catch (aiError) {
        console.error("Errore dall'AI, attivando il Piano B:", aiError);
        // Piano B scatta qui
    }

    // 5. Piano B: Se l'AI fallisce o non restituisce nulla, prendi 3 prodotti a caso
    if (suggestions.length === 0) {
        console.log("Attivazione Piano B: 3 prodotti casuali.");
        suggestions = getRandomProducts(allProducts, 3);
    }
    
    // 6. Rispondi all'app
    res.status(200).json(suggestions);

  } catch (error) {
    console.error('Errore grave nella funzione:', error);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
};


// --- FUNZIONI DI SUPPORTO ---

function createPrompt(prefs, products) {
  // Semplifichiamo la lista prodotti per non appesantire il prompt
  const productListForAI = products.map(({ id, name, description, price, category }) => ({ id, name, description, price, category }));

  return `
    Sei un assistente regali eccezionale, amichevole e creativo. Il tuo compito è scegliere i 3 migliori regali per un utente da una lista di prodotti.
    
    Ecco le preferenze dell'utente:
    - Descrizione della persona: "${prefs.personDescription}"
    - Relazione: ${prefs.relationship}
    - Occasione: ${prefs.occasion}
    - Genere (indicativo): ${prefs.gender}
    - Interessi: ${prefs.hobbies.join(', ')}
    - Fascia d'età: dai ${prefs.ageRange.min} ai ${prefs.ageRange.max} anni
    - Budget massimo: ${prefs.budget.max} euro
    
    Ecco la lista dei prodotti disponibili (ignora quelli palesemente fuori budget):
    ${JSON.stringify(productListForAI)}
    
    Il tuo compito è:
    1. Analizza le preferenze e la lista prodotti.
    2. Seleziona i 3 prodotti che ritieni ASSOLUTAMENTE perfetti.
    3. Per ciascuno dei 3 prodotti, aggiungi una chiave "aiExplanation" con una frase breve (massimo 15 parole), calda e convincente che spieghi PERCHÉ quel regalo è perfetto per quella persona. Esempio: "Per le sue serate nerd, questo è il gadget che non sapeva di volere!".
    
    La tua risposta DEVE ESSERE ESCLUSIVAMENTE un array JSON valido contenente i 3 oggetti prodotto selezionati e arricchiti con la chiave "aiExplanation".
    Non aggiungere nient'altro, né saluti, né testo introduttivo. Solo l'array JSON.
    Formato di risposta atteso:
    [
      { "id": "id_prodotto_1", "aiExplanation": "La tua spiegazione creativa qui." },
      { "id": "id_prodotto_2", "aiExplanation": "La tua spiegazione creativa qui." },
      { "id": "id_prodotto_3", "aiExplanation": "La tua spiegazione creativa qui." }
    ]
  `;
}

function getRandomProducts(products, count) {
    const shuffled = [...products].sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, count);
    
    return selected.map(p => ({
        ...p,
        aiExplanation: "A volte i regali migliori sono una sorpresa! Questo potrebbe piacergli."
    }));
}
