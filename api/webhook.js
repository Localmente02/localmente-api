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
export const config = {
  api: {
    bodyParser: false,
  },
};
// >>> FINE NUOVA CONFIGURAZIONE <<<


module.exports = async (req, res) => {
  console.log("----- Webhook function started! -----");
  console.log("Method:", req.method);
  console.log("Headers:", req.headers);

  if (req.method === 'OPTIONS') {
    console.log("OPTIONS request received.");
    res.status(200).end();
    return;
  }

  if (req.method === 'POST') {
    const sig = req.headers['stripe-signature'];
    
    let event;
    let rawBody;

    try {
        rawBody = await getRawBody(req);
        console.log("Raw body read successful, length:", rawBody ? rawBody.length : 0);
    } catch (error) {
        console.error("Errore nel leggere il raw body dalla richiesta:", error.message);
        return res.status(400).send(`Webhook Error: Failed to read raw body.`);
    }

    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, endpointSecret);
      console.log(`✅ Webhook signature verified. Event type: ${event.type}`);
    } catch (err) {
      console.error(`❌ Errore nella verifica della firma del webhook: ${err.message}`);
      console.error("Raw Body (if available):", rawBody ? rawBody.toString('utf8').substring(0, 500) + '...' : 'Not available');
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntentSucceeded = event.data.object;
        console.log(`✅ PaymentIntent succeeded: ${paymentIntentSucceeded.id}`);
        
        const orderIdFromMetadata = paymentIntentSucceeded.metadata?.orderId;
        const vendorIdFromMetadata = paymentIntentSucceeded.metadata?.vendorId; // Questo è il Firebase UID del venditore

        if (orderIdFromMetadata && db) { // Non controlliamo vendorId qui, perché l'ordine principale può essere multi-venditore
          try {
            // >>> AGGIORNAMENTO 1: Aggiorna l'ordine PRINCIPALE nella collezione 'orders' <<<
            await db.collection('orders').doc(orderIdFromMetadata).set({
              status: 'Pagato', // O lo stato che decidi per l'ordine principale appena pagato
              paymentStatus: 'Completato',
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              stripePaymentIntentId: paymentIntentSucceeded.id,
              amountPaid: paymentIntentSucceeded.amount,
              currencyPaid: paymentIntentSucceeded.currency
            }, { merge: true });
            console.log(`Firestore: Ordine PRINCIPALE ${orderIdFromMetadata} aggiornato/creato come 'Pagato'.`);

            // >>> AGGIORNAMENTO 2: Aggiorna il SOTTO-ORDINE nella collezione 'vendor_orders' <<<
            // Questo lo facciamo SOLO SE il vendorId è presente nei metadata (per ordini di singoli venditori)
            if (vendorIdFromMetadata) {
              await db.collection('vendor_orders').doc(vendorIdFromMetadata).collection('orders').doc(orderIdFromMetadata).set({
                status: 'Pagato', // Anche qui, puoi usare uno stato specifico per il venditore
                paymentStatus: 'Completato',
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                stripePaymentIntentId: paymentIntentSucceeded.id,
                amountPaid: paymentIntentSucceeded.amount,
                currencyPaid: paymentIntentSucceeded.currency
              }, { merge: true });
              console.log(`Firestore: Sotto-ordine ${orderIdFromMetadata} per venditore ${vendorIdFromMetadata} aggiornato/creato come 'Pagato'.`);
            } else {
                console.warn(`Webhook: PaymentIntent riuscito ma vendorId non trovato nei metadata per il sotto-ordine. L'ordine principale è stato aggiornato.`);
            }

          } catch (updateError) {
            console.error(`Firestore: Errore critico nell'aggiornare gli ordini (principale o sotto-ordine) ${orderIdFromMetadata}:`, updateError.message);
          }
        } else {
          console.warn(`Webhook: PaymentIntent riuscito ma OrderId non trovato nei metadata o DB non inizializzato per l'ID ${paymentIntentSucceeded.id}.`);
        }
        break;

      case 'payment_intent.payment_failed':
        const paymentIntentFailed = event.data.object;
        console.log(`❌ PaymentIntent failed: ${paymentIntentFailed.id}`);
        
        const orderIdFailed = paymentIntentFailed.metadata?.orderId;
        const vendorIdFailed = paymentIntentFailed.metadata?.vendorId;

        if (orderIdFailed && db) { // Anche qui, non controlliamo vendorId per l'ordine principale
          try {
            // >>> AGGIORNAMENTO 1: Aggiorna l'ordine PRINCIPALE nella collezione 'orders' <<<
            await db.collection('orders').doc(orderIdFailed).set({
              status: 'Pagamento Fallito',
              paymentStatus: 'Fallito',
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              stripePaymentIntentId: paymentIntentFailed.id,
              lastPaymentError: paymentIntentFailed.last_payment_error?.message || 'Errore sconosciuto'
            }, { merge: true });
            console.log(`Firestore: Ordine PRINCIPALE ${orderIdFailed} aggiornato/creato come 'Pagamento Fallito'.`);

            // >>> AGGIORNAMENTO 2: Aggiorna il SOTTO-ORDINE nella collezione 'vendor_orders' <<<
            if (vendorIdFailed) {
              await db.collection('vendor_orders').doc(vendorIdFailed).collection('orders').doc(orderIdFailed).set({
                status: 'Pagamento Fallito',
                paymentStatus: 'Fallito',
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                stripePaymentIntentId: paymentIntentFailed.id,
                lastPaymentError: paymentIntentFailed.last_payment_error?.message || 'Errore sconosciuto'
              }, { merge: true });
              console.log(`Firestore: Sotto-ordine ${orderIdFailed} per venditore ${vendorIdFailed} aggiornato/creato come 'Pagamento Fallito'.`);
            } else {
                console.warn(`Webhook: PaymentIntent fallito ma vendorId non trovato nei metadata per il sotto-ordine. L'ordine principale è stato aggiornato.`);
            }

          } catch (updateError) {
            console.error(`Firestore: Errore critico nell'aggiornare gli ordini falliti (principale o sotto-ordine) ${orderIdFailed}:`, updateError.message);
          }
        } else {
          console.warn(`Webhook: PaymentIntent fallito ma OrderId non trovato nei metadata o DB non inizializzato per l'ID ${paymentIntentFailed.id}.`);
        }
        break;

      default:
        console.log(`Unhandled event type ${event.type} received.`);
    }

    res.status(200).json({ received: true });
  } else {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).end('Method Not Allowed');
  }
};

function getRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => {
            chunks.push(chunk);
        });
        req.on('end', () => {
            resolve(Buffer.concat(chunks));
        });
        req.on('error', (err) => {
            reject(err);
        });
    });
}
