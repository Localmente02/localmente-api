import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GoogleGenerativeAI } from '@google/generative-ai';


let db;
if (!global.firebaseAdminApp) {
  try {
    const serviceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Importante per gestire i newline
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    };
    global.firebaseAdminApp = initializeApp({
      credential: cert(serviceAccount),
    });
    console.log("Firebase Admin SDK initialized successfully.");
  } catch (error) {
    console.error("Failed to initialize Firebase Admin SDK:", error);
  }
}
db = getFirestore(global.firebaseAdminApp);


export default async function (req, res) {
 
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non permesso. Si accettano solo richieste POST.' });
  }

  try {
    const { userPreferences, userCurrentLocation } = req.body;

    if (!userPreferences || !userCurrentLocation || !userCurrentLocation.cap) {
      return res.status(400).json({ error: 'Mancano dati essenziali: userPreferences o CAP della posizione attuale.' });
    }

    const {
      interessi,
      eta,
      genere,
      budget,
      personalita,
      relazione,
      occasione,
      noteAggiuntive 
    } = userPreferences;

    const userCap = userCurrentLocation.cap;

    let productsSnapshot;
    try {
        productsSnapshot = await db.collection('global_product_catalog')
            .where('isAvailable', '==', true)
            .where('isMarketplaceActive', '==', true)
            .where('vendorCap', '==', userCap)
            .where('isPiazzaVendor', '==', true)
            .limit(500)
            .get();
    } catch (firebaseError) {
        console.error("Errore nel recupero dei prodotti da Firestore:", firebaseError);
        return res.status(500).json([]); // Restituisci array vuoto in caso di errore
    }

    const availableProducts = productsSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id, // Usa l'ID del documento Firestore
        nome: data.productName,
        descrizione: data.description || '',
        categoria_principale: data.categoryGroup,
        sottocategoria: data.subCategory || '',
        prezzo: data.price,
        unita: data.unit || 'pezzo',
        imageUrl: data.imageUrls && data.imageUrls.length > 0 ? data.imageUrls[0] : null,
        keywords: data.keywords || [],
      };
    }).filter(p => p.prezzo > 0 && p.nome);

    if (availableProducts.length === 0) {
        console.log(`Nessun prodotto trovato per il CAP: ${userCap}`);
        return res.status(404).json([]); // Restituisci array vuoto
    }

    const API_KEY = process.env.GOOGLE_API_KEY;
    if (!API_KEY) {
      console.error("GOOGLE_API_KEY non è configurata.");
      return res.status(500).json([]); // Restituisci array vuoto
    }

    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });

    const promptText = `Sei un esperto selezionatore di regali unico e personalizzato sulla piattaforma Localmente. Il tuo obiettivo è suggerire i 3 migliori regali basandoti sui 'Dati Utente' e sui 'Prodotti Disponibili' che ti verranno forniti.

Dati Utente:
- Interessi: ${interessi ? interessi.join(', ') : 'non specificato'}
- Età: ${eta || 'non specificata'}
- Genere: ${genere || 'non specificato'}
- Budget: ${budget || 'non specificato'}
- Personalità: ${personalita || 'non specificata'}
- Relazione: ${relazione || 'non specificata'}
- Occasione: ${occasione || 'non specificata'}
- Note Aggiuntive: ${noteAggiuntive || 'nessuna'}

Prodotti Disponibili (formato JSON):
${JSON.stringify(availableProducts, null, 2)}

Istruzioni per i suggerimenti (Output JSON):
1.  Per ogni regalo suggerito, forniscimi ESATTAMENTE un oggetto JSON con i seguenti campi: "id", "nome", "prezzo", "spiegazione".
2.  L' "id" deve essere l'ID esatto del prodotto presente nella lista "Prodotti Disponibili".
3.  La "spiegazione" deve essere concisa (massimo 3 frasi) e collegare direttamente il regalo agli interessi, alla personalità o all'occasione del destinatario.
4.  I prodotti suggeriti DEVONO rientrare nel budget indicato dall'utente. Se il budget è una fascia (es. "50-100"), il prezzo del regalo deve essere all'interno di quella fascia.
5.  Sii creativo e originale nei suggerimenti.
6.  Presenta i risultati ESCLUSIVAMENTE come un array JSON di 3 oggetti. NON includere testo aggiuntivo, introduzioni, o formattazioni Markdown prima o dopo l'array JSON.

Esempio del formato di output DESIDERATO (SOLO L'ARRAY JSON):
[
  {
    "id": "prod_XYZ1",
    "nome": "Nome Prodotto Esempio 1",
    "prezzo": 55.00,
    "spiegazione": "Questo regalo è ideale perché..."
  },
  {
    "id": "prod_XYZ2",
    "nome": "Nome Prodotto Esempio 2",
    "prezzo": 80.00,
    "spiegazione": "Perfetto per la sua passione per..."
  },
  {
    "id": "prod_XYZ3",
    "nome": "Nome Prodotto Esempio 3",
    "prezzo": 42.50,
    "spiegazione": "Un'esperienza unica per l'occasione di..."
  }
]
`;

    const result = await model.generateContent(promptText);
    const response = await result.response;
    let aiResponseText = response.text();

    aiResponseText = aiResponseText.replace(/```json\n|```/g, '').trim();

    let parsedSuggestions;
    try {
        parsedSuggestions = JSON.parse(aiResponseText);
        if (!Array.isArray(parsedSuggestions)) {
            throw new Error("L'output non è un array.");
        }
    } catch (parseError) {
        console.error("Errore nel parsing della risposta JSON dell'AI:", aiResponseText, parseError);
        return res.status(500).json([]); // Restituisci array vuoto
    }

    const finalSuggestions = parsedSuggestions.map(suggestion => {
        const fullProduct = availableProducts.find(p => p.id === suggestion.id);
        if (fullProduct) {
            return {
                ...suggestion, // Prende id, nome, prezzo, spiegazione dall'AI
                imageUrl: fullProduct.imageUrl,
                unit: fullProduct.unita,
            };
        }
        return null;
    }).filter(Boolean);
    

    res.status(200).json(finalSuggestions);

  } catch (error) {
    console.error('Errore generico durante la generazione dei suggerimenti:', error);
    res.status(500).json([]); // Restituisci array vuoto in caso di errore grave
  }
}
