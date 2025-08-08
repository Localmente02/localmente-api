const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Inizializzazione di Firebase (una sola volta)
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
  } catch (e) {
    console.error("Firebase Admin Init Error:", e);
  }
}
const db = admin.firestore();
db.settings({ preferRest: true }); // Impostazione di sicurezza per la connessione

// Funzione per mescolare un array (per i suggerimenti casuali)
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// Funzione principale che viene eseguita da Vercel
module.exports = async (req, res) => {
  // Impostazioni CORS per permettere all'app di comunicare
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // 1. Recupera i dati inviati dall'app Flutter
    const { userPreferences, userCurrentLocation } = req.body;

    if (!userPreferences || !userCurrentLocation || !userCurrentLocation.cap) {
      return res.status(400).json({ error: 'Dati mancanti nella richiesta.' });
    }
    const userCap = userCurrentLocation.cap;

    // 2. Cerca i prodotti su Firebase basandosi sul CAP dell'utente
    const productsSnapshot = await db.collection('global_product_catalog')
      .where('isAvailable', '==', true)
      .where('isMarketplaceActive', '==', true)
      .where('vendorCap', '==', userCap)
      .limit(100) // Limita a 100 per non sovraccaricare l'AI
      .get();

    // Se non ci sono prodotti, restituisci una lista vuota
    if (productsSnapshot.empty) {
      console.log(`Nessun prodotto trovato per il CAP ${userCap}.`);
      return res.status(200).json([]);
    }

    // Prepara la lista dei prodotti per l'AI
    const availableProducts = productsSnapshot.docs.map(doc => {
        const data = doc.data();
        return {
            id: doc.id,
            nome: data.productName,
            prezzo: data.price,
            descrizione: data.description,
            imageUrl: data.imageUrls && data.imageUrls.length > 0 ? data.imageUrls[0] : null,
            unit: data.unit || '',
        };
    });

    // 3. Chiama l'Intelligenza Artificiale (Google Gemini)
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Modello corretto!

    const prompt = `Sei un esperto di regali. Suggerisci 3 prodotti dal catalogo in base alle preferenze. Rispondi SOLO con un array JSON con campi "id", "nome", "prezzo", "spiegazione". La spiegazione deve essere breve e convincente.
      Preferenze Utente: ${JSON.stringify(userPreferences)}
      Catalogo Prodotti: ${JSON.stringify(availableProducts.map(p => ({id: p.id, nome: p.nome, prezzo: p.prezzo, descrizione: p.descrizione})))}
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    // Pulisce la risposta dell'AI da eventuali caratteri extra
    let aiResponseText = response.text().replace(/```json\n|```/g, '').trim();

    let finalSuggestions = [];
    try {
      const parsedSuggestions = JSON.parse(aiResponseText);
      // Controlla se l'AI ha risposto correttamente con una lista
      if (Array.isArray(parsedSuggestions)) {
        // Arricchisce i suggerimenti dell'AI con i dati completi del prodotto
        finalSuggestions = parsedSuggestions.map(suggestion => {
          const product = availableProducts.find(p => p.id === suggestion.id);
          return product ? { ...suggestion, spiegazione: suggestion.spiegazione || "Un'ottima idea regalo!", imageUrl: product.imageUrl, unit: product.unit } : null;
        }).filter(Boolean); // Rimuove eventuali risultati nulli
      }
    } catch (e) {
      console.log("L'AI non ha risposto con un JSON valido, attivo il fallback.");
      // Se c'è un errore, `finalSuggestions` rimane una lista vuota, attivando il fallback
    }

    // 4. Logica di Fallback (se l'AI non dà risultati)
    if (finalSuggestions.length === 0 && availableProducts.length > 0) {
      console.log("Nessun suggerimento intelligente. Fornisco 3 prodotti casuali.");
      const shuffledProducts = shuffleArray(availableProducts);
      const randomSuggestions = shuffledProducts.slice(0, 3).map(product => ({
        id: product.id,
        nome: product.nome,
        prezzo: product.prezzo,
        spiegazione: "Te lo suggeriamo perché è un prodotto di qualità della tua zona!",
        imageUrl: product.imageUrl,
        unit: product.unit,
      }));
      finalSuggestions = randomSuggestions;
    }

    // 5. Invia la risposta finale all'app Flutter
    return res.status(200).json(finalSuggestions);

  } catch (error) {
    console.error('Errore grave nella funzione regalo:', error.message);
    return res.status(500).json({ error: 'Errore interno del server.' });
  }
};
