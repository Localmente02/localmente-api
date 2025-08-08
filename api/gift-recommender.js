// api/gift-recommender.js

const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- CONFIGURAZIONE ---
// Inizializza Firebase Admin SDK
// Le credenziali vengono lette automaticamente dalle Environment Variables di Vercel
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
    });
  }
} catch (e) {
  console.error('Firebase Admin Initialization Error', e.stack);
}
const db = admin.firestore();

// Inizializza Google Gemini
// La API Key viene letta automaticamente dalle Environment Variables di Vercel
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-pro' });


// --- FUNZIONE PRINCIPALE ---
module.exports = async (req, res) => {
  // Imposta header per CORS (permettono all'app di chiamare l'API da qualsiasi origine)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Gestione della richiesta pre-flight OPTIONS
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non consentito' });
  }

  try {
    const userPreferences = req.body;

    // 1. Recupera i prodotti da Firebase
    const productsSnapshot = await db.collection('global_product_catalog').limit(100).get();
    if (productsSnapshot.empty) {
      return res.status(404).json({ error: 'Nessun prodotto trovato nel nostro catalogo globale.' });
    }
    const allProducts = productsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    let suggestions = [];
    
    try {
        // 2. Prepara il prompt per l'AI
        const prompt = createPrompt(userPreferences, allProducts);
        
        // 3. Chiama l'AI
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        
        // 4. Interpreta la risposta in modo robusto
        const cleanJsonString = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const aiSuggestions = JSON.parse(cleanJsonString);

        if (aiSuggestions && Array.isArray(aiSuggestions) && aiSuggestions.length > 0) {
            // Arricchisci i suggerimenti AI con i dati completi (es. imageUrl, prezzo, ecc.)
            suggestions = aiSuggestions.map(aiSugg => {
                const fullProduct = allProducts.find(p => p.id === aiSugg.id);
                if (!fullProduct) return null; // Salta se l'AI ha inventato un ID
                
                return {
                    id: fullProduct.id,
                    name: fullProduct.name,
                    price: fullProduct.price,
                    imageUrl: fullProduct.imageUrl,
                    aiExplanation: aiSugg.aiExplanation || "Un'ottima scelta basata sulle tue preferenze."
                };
            }).filter(p => p !== null); // Rimuovi eventuali null
        }
    } catch (aiError) {
        console.error("ERRORE DALL'AI, attivando il Piano B:", aiError);
        // Piano B scatta qui se l'AI fallisce (es. formato JSON errato, errore API, etc.)
    }

    // 5. Piano B: Se l'AI fallisce o non restituisce nulla, prendi 3 prodotti a caso
    if (suggestions.length === 0) {
        console.log("ATTIVAZIONE PIANO B: Restituisco 3 prodotti casuali.");
        suggestions = getRandomProducts(allProducts, 3);
    }
    
    // 6. Rispondi all'app
    return res.status(200).json(suggestions);

  } catch (error) {
    console.error('ERRORE GRAVE NELLA FUNZIONE:', error);
    return res.status(500).json({ error: 'Errore interno del nostro assistente. Riprova più tardi.' });
  }
};


// --- FUNZIONI DI SUPPORTO ---

function createPrompt(prefs, products) {
  const productListForAI = products.map(({ id, name, description, price, category }) => ({ id, name, description, price, category }));

  return `
    Sei un assistente regali eccezionale, amichevole e creativo. Il tuo compito è scegliere i 3 migliori regali per un utente da una lista di prodotti.
    
    Ecco le preferenze dell'utente:
    - Descrizione della persona: "${prefs.personDescription || 'Non specificata'}"
    - Relazione: ${prefs.relationship}
    - Occasione: ${prefs.occasion}
    - Genere (indicativo): ${prefs.gender}
    - Interessi: ${prefs.hobbies.join(', ') || 'Non specificati'}
    - Fascia d'età: dai ${prefs.ageRange.min} ai ${prefs.ageRange.max} anni
    - Budget massimo: ${prefs.budget.max} euro
    
    Ecco la lista dei prodotti disponibili (ignora quelli palesemente fuori budget e non pertinenti):
    ${JSON.stringify(productListForAI.slice(0, 50))} 
    
    Il tuo compito è:
    1. Analizza attentamente le preferenze e la lista prodotti.
    2. Seleziona i 3 prodotti che ritieni ASSOLUTAMENTE perfetti.
    3. Per ciascuno dei 3 prodotti, scrivi una motivazione. Crea una chiave "aiExplanation" con una frase breve (massimo 15 parole), calda e convincente che spieghi PERCHÉ quel regalo è perfetto per quella persona. Esempio: "Per le sue serate nerd, questo è il gadget che non sapeva di volere!".
    
    La tua risposta DEVE ESSERE ESCLUSIVAMENTE un array JSON valido contenente i 3 oggetti prodotto selezionati. Ogni oggetto deve contenere solo "id" e "aiExplanation".
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
        id: p.id,
        name: p.name,
        price: p.price,
        imageUrl: p.imageUrl,
        aiExplanation: "A volte i regali migliori sono una sorpresa! Questo potrebbe fare al caso suo."
    }));
}
