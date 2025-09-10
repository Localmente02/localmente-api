// api/create-payment-intent.js

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// --- Inizializza Firebase Admin SDK UNA SOLA VOLTA ---
let db;
let messaging;

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
            messaging = admin.messaging();
            console.log("Firebase Admin SDK inizializzato con successo in create-payment-intent. Firestore e Messaging pronti.");
        } catch (initError) {
            console.error("Errore nell'inizializzazione finale di Firebase Admin SDK in create-payment-intent:", initError.message);
        }
    } else {
        console.error("FIREBASE_SERVICE_ACCOUNT_KEY non trovata o non valida. Firebase Admin SDK non inizializzato in create-payment-intent.");
    }
} else {
    db = admin.firestore();
    messaging = admin.messaging();
    console.log("Firebase Admin SDK già inizializzato, recupero istanze Firestore e Messaging in create-payment-intent.");
}
// --- Fine Inizializzazione Firebase Admin SDK ---


// --- Funzione per inviare notifiche push ---
async function sendPushNotification(userId, title, body, data = {}, notificationType) {
    if (!db || !messaging || !userId) {
        console.error("Cannot send notification: DB, Messaging, or userId not available.");
        return;
    }

    // --- NUOVO: Controlla le preferenze dell'utente prima di inviare ---
    try {
        const userPrefsDoc = await db.collection('users').doc(userId).collection('preferences').doc('notification_settings').get();
        const userPrefs = userPrefsDoc.data();

        // Controllo generale per le push globali
        const globalPushEnabled = userPrefs?.receivePushNotifications ?? false;
        if (!globalPushEnabled) {
            console.log(`Global push notifications disabled for user ${userId}. Notification not sent.`);
            return;
        }

        // Controllo per il tipo specifico di notifica
                let specificNotificationEnabled = true;
                if (notificationType === 'payment') {
                    specificNotificationEnabled = userPrefs?.receivePaymentNotifications ?? true; // Default a true se non settato
                } else if (notificationType === 'wish_response') { // <<< AGGIUNGI QUESTA RIGA
                    specificNotificationEnabled = userPrefs?.receiveWishNotifications ?? true; // <<< E QUESTA RIGA
                } else if (notificationType === 'favorite_vendor_new_product') {
                    specificNotificationEnabled = userPrefs?.receiveFavoriteVendorNewProducts ?? true;
                } else if (notificationType === 'favorite_vendor_special_offer') {
                    specificNotificationEnabled = userPrefs?.receiveFavoriteVendorSpecialOffers ?? true;
                }
                // Aggiungi qui altri tipi di notifica
        
        if (!specificNotificationEnabled) {
            console.log(`Specific notification type "${notificationType}" disabled for user ${userId}. Notification not sent.`);
            return;
        }

    } catch (e) {
        console.error(`Error checking notification preferences for user ${userId}:`, e);
        // In caso di errore nel leggere le preferenze, per sicurezza inviamo la notifica
        // Oppure potresti decidere di non inviarla. Dipende dalla tua policy.
        // Per ora, proseguiamo, ma logghiamo l'errore.
    }
    // --- FINE NUOVO: Controllo preferenze ---

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
// --- Fine Funzione sendPushNotification ---


module.exports = async (req, res) => {
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
        sendNotification,
        notificationTitle,
        notificationBody,
        notificationData,
        // --- NUOVO: Tipo di notifica per il controllo delle preferenze ---
        notificationType 
      } = req.body;

      // --- Logica per inviare una notifica (NUOVO e modificato) ---
      if (sendNotification && customerUserId && messaging && db) {
          console.log(`Received request to send notification for user ${customerUserId}.`);
          await sendPushNotification(
              customerUserId,
              notificationTitle || "Notifica da Localmente",
              notificationBody || "Controlla l'app per i dettagli!",
              notificationData || {},
              notificationType // Passa il tipo di notifica
          );
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
      console.error('Error in create-payment-intent:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  } else {
    res.setHeader('Allow', 'POST');
    res.status(405).end('Method Not Allowed');
  }
};
