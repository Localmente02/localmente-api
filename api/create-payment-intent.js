// api/create-payment-intent.js

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// --- NUOVO: Inizializza Firebase Admin SDK UNA SOLA VOLTA ---
let db;
let messaging; // Servizio per inviare notifiche

if (!admin.apps.length) {
    let firebaseConfig = null;
    const firebaseServiceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

    if (firebaseServiceAccountKey) {
        try {
            firebaseConfig = JSON.parse(firebaseServiceAccountKey);
        } catch (e) {
            try {
                firebaseConfig = JSON.parse(Buffer.from(firebaseServiceAccountKey, 'base64').toString('utf8'));
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
            db = admin.firestore();
            messaging = admin.messaging(); // Inizializza anche il servizio di Messaging
            console.log("Firebase Admin SDK inizializzato con successo in create-payment-intent. Firestore e Messaging pronti.");
        } catch (initError) {
            console.error("Errore nell'inizializzazione finale di Firebase Admin SDK in create-payment-intent:", initError.message);
        }
    } else {
        console.error("FIREBASE_SERVICE_ACCOUNT_KEY non trovata o non valida. Firebase Admin SDK non inizializzato in create-payment-intent.");
    }
} else {
    // Se già inizializzato, prendi le istanze esistenti
    db = admin.firestore();
    messaging = admin.messaging();
    console.log("Firebase Admin SDK già inizializzato, recupero istanze Firestore e Messaging in create-payment-intent.");
}
// --- FINE NUOVO: Inizializzazione Firebase Admin SDK ---


// --- NUOVO: Funzione per inviare notifiche push (copiata dall'altro file) ---
async function sendPushNotification(userId, title, body, data = {}) {
    if (!db || !messaging || !userId) {
        console.error("Cannot send notification: DB, Messaging, or userId not available.");
        return;
    }

    try {
        const userTokensSnapshot = await db.collection('users').doc(userId).collection('fcmTokens').get();
        const tokens = userTokensSnapshot.docs.map(doc => doc.id);

        if (tokens.length === 0) {
            console.log(`No FCM tokens found for user ${userId}. Notification not sent.`);
            return;
        }

        const message = {
            notification: { title, body },
            data: data,
            tokens: tokens,
        };

        const response = await messaging.sendEachForMulticast(message);
        console.log(`Notification sent to user ${userId} from create-payment-intent. Success: ${response.successCount}, Failure: ${response.failureCount}`);

        if (response.failureCount > 0) {
            response.responses.forEach(async (resp, idx) => {
                if (!resp.success) {
                    const invalidToken = tokens[idx];
                    console.error(`Failed to send to token ${invalidToken}:`, resp.exception);
                    await db.collection('users').doc(userId).collection('fcmTokens').doc(invalidToken).delete();
                }
            });
        }

    } catch (error) {
        console.error(`Error sending push notification to user ${userId} from create-payment-intent:`, error);
    }
}
// --- FINE NUOVO: Funzione sendPushNotification ---


module.exports = async (req, res) => {
  // --- NUOVO: Log per capire l'inizio della funzione ---
  console.log("----- create-payment-intent function started! -----");

  if (req.method === 'POST') {
    try {
      const { 
        amount, 
        currency, 
        description, 
        stripeAccountId, 
        applicationFeeAmount, 
        metadata,
        customerUserId,
        // --- NUOVO: Campo per indicare di inviare una notifica ---
        sendNotification,
        notificationTitle,
        notificationBody,
        notificationData // Dati extra per la navigazione
      } = req.body;

      // --- NUOVO: Se Flutter ci chiede di inviare una notifica ---
      if (sendNotification && customerUserId && messaging && db) {
          console.log(`Received request to send notification for user ${customerUserId}.`);
          await sendPushNotification(
              customerUserId,
              notificationTitle || "Notifica da Localmente", // Titolo di default se non fornito
              notificationBody || "Controlla l'app per i dettagli!", // Corpo di default
              notificationData || {} // Dati extra per l'app
          );
          // Rispondi a Flutter che la notifica è stata gestita
          return res.status(200).json({ message: 'Notification sent successfully.' });
      }


      // --- LOGICA ESISTENTE PER CREARE PAYMENT INTENT ---
      if (!amount || !currency || !customerUserId) {
        return res.status(400).json({ error: 'Missing amount, currency, or customerUserId' });
      }

      const params = {
        amount: parseInt(amount),
        currency: currency,
        payment_method_types: ['card'],
        description: description || 'No description provided',
        metadata: {
          ...metadata,
          customerUserId: customerUserId
        },
      };

      if (stripeAccountId) {
        params.transfer_data = {
          destination: stripeAccountId,
        };
        if (applicationFeeAmount) {
          params.application_fee_amount = parseInt(applicationFeeAmount);
        }
      }

      const paymentIntent = await stripe.paymentIntents.create(params);

      res.status(200).json({ clientSecret: paymentIntent.client_secret });

    } catch (error) {
      console.error('Error in create-payment-intent:', error); // --- Modificato: Log più specifico ---
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  } else {
    res.setHeader('Allow', 'POST');
    res.status(405).end('Method Not Allowed');
  }
};
