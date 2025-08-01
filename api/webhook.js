// api/webhook.js

// Importa la libreria Stripe
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Importa la libreria Firebase Admin SDK
const admin = require('firebase-admin');

// Variabile globale per il database di Firestore
let db;

// Inizializza Firebase Admin SDK
if (!admin.apps.length) {
  let firebaseConfig = null;
  const firebaseServiceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (firebaseServiceAccountKey) {
    try {
      // Tentativo 1: Prova a leggere come JSON diretto (più comune per Vercel)
      firebaseConfig = JSON.parse(firebaseServiceAccountKey);
      console.log("Attempting Firebase Admin SDK initialization with direct JSON.");
    } catch (e) {
      // Tentativo 2: Se fallisce, prova a decodificare da Base64 (utile se l'utente l'ha codificato)
      try {
        firebaseConfig = JSON.parse(Buffer.from(firebaseServiceAccountKey, 'base64').toString('utf8'));
        console.log("Attempting Firebase Admin SDK initialization with Base64 decoded JSON.");
      } catch (e2) {
        console.error("FIREBASE_SERVICE_ACCOUNT_KEY: Errore nel parsing (non è né JSON diretto né Base64 valido):", e2.message);
      }
    }
  }

  if (firebaseConfig) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert(firebaseConfig)
      });
      db = admin.firestore(); // Assegna il database solo se l'inizializzazione ha successo
      console.log("Firebase Admin SDK inizializzato con successo.");
    } catch (initError) {
      console.error("Errore nell'inizializzazione finale di Firebase Admin SDK:", initError.message);
      // Se c'è un errore qui, la funzione non potrà interagire con Firestore
      // e db rimarrà non definito.
    }
  } else {
    console.error("FIREBASE_SERVICE_ACCOUNT_KEY non trovata o non valida. Firebase Admin SDK non inizializzato.");
  }
} else {
  // Se l'app Admin è già stata inizializzata (es. in un re-run a caldo), prendi l'istanza di Firestore
  db = admin.firestore();
  console.log("Firebase Admin SDK già inizializzato, recupero istanza Firestore.");
}

// Questo è il segreto del webhook, IMPORTANTISSIMO per la sicurezza!
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// >>> NUOVA CONFIGURAZIONE PER VERCEL: DISABILITA IL PARSING AUTOMATICO DEL BODY <<<
// Questo è CRUCIALE per Stripe webhooks, perché Stripe ha bisogno del 'raw' body
// per verificare la firma. Vercel lo parserebbe automaticamente in JSON.
export const config = {
  api: {
    bodyParser: false, // Disabilita il body parser predefinito di Vercel per questo endpoint
  },
};
// >>> FINE NUOVA CONFIGURAZIONE <<<


module.exports = async (req, res) => {
  // QUESTO È IL NOSTRO MESSAGGIO DI TEST PER VEDERE SE LA FUNZIONE PARTE!
  console.log("----- Webhook function started! -----");

  // Gestione delle richieste OPTIONS per CORS preflight
  if (req.method === 'OPTIONS') {
    console.log("OPTIONS request received.");
    res.status(200).end();
    return;
  }

  if (req.method === 'POST') {
    const sig = req.headers['stripe-signature'];

    let event;

    // Quando bodyParser è false, req.body è uno stream. Dobbiamo leggerlo.
    // Stripe ha un helper per questo, ma possiamo farlo manualmente.
    let rawBodyBuffer;
    try {
        rawBodyBuffer = await getRawBody(req);
    } catch (error) {
        console.error("Errore nel leggere il raw body:", error.message);
        return res.status(400).send(`Webhook Error: Raw body read failed.`);
    }

    try {
      // Usiamo rawBodyBuffer per la verifica della firma
      event = stripe.webhooks.constructEvent(rawBodyBuffer, sig, endpointSecret);
    } catch (err) {
      console.error(`❌ Errore nella verifica della firma del webhook: ${err.message}`);
      // Un errore comune qui è "No raw body received" o "Invalid signature".
      // Se accade, la funzione comunque risponde con 400.
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Gestisci i diversi tipi di eventi Stripe
    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntentSucceeded = event.data.object;
        console.log(`✅ PaymentIntent succeeded: ${paymentIntentSucceeded.id}`);
        
        const orderIdFromMetadata = paymentIntentSucceeded.metadata?.orderId;
        const vendorIdFromMetadata = paymentIntentSucceeded.metadata?.vendorId;

        if (orderIdFromMetadata && vendorIdFromMetadata && db) {
          try {
            await db.collection('vendor_orders').doc(vendorIdFromMetadata).collection('orders').doc(orderIdFromMetadata).update({
              status: 'Pagato',
              paymentStatus: 'Completato',
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              stripePaymentIntentId: paymentIntentSucceeded.id,
              amountPaid: paymentIntentSucceeded.amount,
              currencyPaid: paymentIntentSucceeded.currency
            });
            console.log(`Firestore: Ordine ${orderIdFromMetadata} aggiornato a 'Pagato'.`);
          } catch (updateError) {
            console.error(`Firestore: Errore nell'aggiornare l'ordine ${orderIdFromMetadata}:`, updateError.message);
          }
        } else {
          console.warn(`Webhook: PaymentIntent riuscito ma OrderId o VendorId non trovati nei metadata o DB non inizializzato per l'ID ${paymentIntentSucceeded.id}.`);
        }
        break;

      case 'payment_intent.payment_failed':
        const paymentIntentFailed = event.data.object;
        console.log(`❌ PaymentIntent failed: ${paymentIntentFailed.id}`);
        
        const orderIdFailed = paymentIntentFailed.metadata?.orderId;
        const vendorIdFailed = paymentIntentFailed.metadata?.vendorId;

        if (orderIdFailed && vendorIdFailed && db) {
          try {
            await db.collection('vendor_orders').doc(vendorIdFailed).collection('orders').doc(orderIdFailed).update({
              status: 'Pagamento Fallito',
              paymentStatus: 'Fallito',
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              stripePaymentIntentId: paymentIntentFailed.id,
              lastPaymentError: paymentIntentFailed.last_payment_error?.message || 'Errore sconosciuto'
            });
            console.log(`Firestore: Ordine ${orderIdFailed} aggiornato a 'Pagamento Fallito'.`);
          } catch (updateError) {
            console.error(`Firestore: Errore nell'aggiornare l'ordine fallito ${orderIdFailed}:`, updateError.message);
          }
        }
        break;

      default:
        console.log(`Unhandled event type ${event.type} received.`);
    }

    // Invia una risposta di successo a Stripe (obbligatorio)
    res.status(200).json({ received: true });
  } else {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).end('Method Not Allowed');
  }
};

// Funzione helper per leggere il raw body da una richiesta Node.js stream
// Necessario quando bodyParser: false è abilitato.
function getRawBody(req) {
    return new Promise((resolve, reject) => {
        let bodyBuffer = [];
        req.on('data', chunk => {
            bodyBuffer.push(chunk);
        });
        req.on('end', () => {
            resolve(Buffer.concat(bodyBuffer));
        });
        req.on('error', err => {
            reject(err);
        });
    });
}
