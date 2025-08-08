const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const TEST_PREFERENCES = {
  interessi: ["tecnologia", "gaming"],
  eta: "25-35",
  budget: "50-200",
  occasione: "compleanno"
};

const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
};
const googleApiKey = process.env.GOOGLE_API_KEY;

if (!serviceAccount.projectId || !serviceAccount.clientEmail || !serviceAccount.privateKey || !googleApiKey) {
    console.error("!!! ERRORE: MANCANO LE CREDENZIALI.");
    return;
}

try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
} catch(e) {
    console.error("!!! ERRORE INIZIALIZZAZIONE FIREBASE:", e.message);
    return;
}

const db = admin.firestore();
db.settings({ preferRest: true });

const genAI = new GoogleGenerativeAI(googleApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
async function runTest() {
  console.log(`--- INIZIO TEST SENZA NESSUN FILTRO ---`);

  try {
    console.log("1. Sto prendendo i prodotti da 'global_product_catalog'...");
    const productsSnapshot = await db.collection('global_product_catalog')
      .limit(100)
      .get();

    if (productsSnapshot.empty) {
      console.log(`\nRISULTATO: Connessione a Firebase OK, ma la collezione 'global_product_catalog' è VUOTA.`);
      return;
    }

    const availableProducts = productsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    console.log(`   SUCCESSO! Trovati ${availableProducts.length} prodotti.`);

    console.log("\n2. Sto inviando i dati all'AI...");
    const prompt = `Suggerisci 3 regali dal catalogo, basandoti sulle preferenze. Rispondi SOLO con un array JSON.
      Preferenze: ${JSON.stringify(TEST_PREFERENCES)}
      Catalogo: ${JSON.stringify(availableProducts.map(p => ({id: p.id, productName: p.productName, price: p.price, description: p.description})))}
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    console.log("   RISPOSTA DALL'AI RICEVUTA!");
    console.log("------------------------------------------");
    console.log(text);
    console.log("------------------------------------------");

    try {
      JSON.parse(text);
      console.log("\n--- TEST COMPLETATO CON SUCCESSO! ---");
    } catch (e) {
      console.log("\n!!! ERRORE: L'AI non ha risposto con un JSON valido.");
    }

  } catch (error) {
    console.log("\n!!! ERRORE DURANTE IL TEST !!!");
    console.error(error);
  }
}

runTest();
