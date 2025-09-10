// api/webhook.js

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// Inizializza Firebase Admin SDK UNA SOLA VOLTA
let db;
let messaging;

if (!admin.apps.length) {
    let firebaseConfig = null;
    const firebaseServiceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

    if (firebaseServiceAccountKey) {
        try {
            firebaseConfig = JSON.parse(firebaseServiceAccountKey);
            // console.log("Attempting Firebase Admin SDK initialization with direct JSON.");
        } catch (e) {
            try {
                firebaseConfig = JSON.parse(Buffer.from(firebaseServiceAccountKey, 'base64').toString('utf8'));
                // console.log("Attempting Firebase Admin SDK initialization with Base64 decoded JSON.");
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
            console.log("Firebase Admin SDK inizializzato con successo. Firestore e Messaging pronti.");
        } catch (initError) {
            console.error("Errore nell'inizializzazione finale di Firebase Admin SDK:", initError.message);
        }
    } else {
        console.error("FIREBASE_SERVICE_ACCOUNT_KEY non trovata o non valida. Firebase Admin SDK non inizializzato.");
    }
} else {
    // Se già inizializzato, prendi le istanze esistenti
    db = admin.firestore();
    messaging = admin.messaging();
    console.log("Firebase Admin SDK già inizializzato, recupero istanze Firestore e Messaging.");
}

// Il segreto del webhook di Stripe, IMPORTANTISSIMO per la sicurezza!
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Disabilita il parsing automatico del body di Vercel per Stripe
export const config = {
    api: {
        bodyParser: false,
    },
};

// Funzione helper per ottenere il raw body della richiesta
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

// >>> FUNZIONE AGGIUNTA PER INVIARE NOTIFICHE PUSH (Il tuo "Postino Vercel" integrato!) <<<
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
        console.log(`Notification sent to user ${userId}. Success: ${response.successCount}, Failure: ${response.failureCount}`);

        // Rimuovi i token non più validi (opzionale, ma buona pratica)
        if (response.failureCount > 0) {
            response.responses.forEach(async (resp, idx) => {
                if (!resp.success) {
                    const invalidToken = tokens[idx];
                    console.error(`Failed to send to token ${invalidToken}:`, resp.exception);
                    // Rimuovi il token invalido dal database
                    await db.collection('users').doc(userId).collection('fcmTokens').doc(invalidToken).delete();
                }
            });
        }

    } catch (error) {
        console.error(`Error sending push notification to user ${userId}:`, error);
    }
}
// >>> FINE FUNZIONE AGGIUNTA <<<


module.exports = async (req, res) => {
    console.log("----- Stripe Webhook function started! -----");

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
            // console.log("Raw body read successful, length:", rawBody ? rawBody.length : 0);
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
                const vendorIdFromMetadata = paymentIntentSucceeded.metadata?.vendorId;
                const customerUserIdFromMetadata = paymentIntentSucceeded.metadata?.customerUserId; // <<< NUOVO: ID UTENTE DAL METADATA


                if (orderIdFromMetadata && db) {
                    try {
                        // Aggiorna l'ordine PRINCIPALE nella collezione 'orders'
                        await db.collection('orders').doc(orderIdFromMetadata).set({
                            status: 'Pagato',
                            paymentStatus: 'Completato',
                            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                            stripePaymentIntentId: paymentIntentSucceeded.id,
                            amountPaid: paymentIntentSucceeded.amount,
                            currencyPaid: paymentIntentSucceeded.currency
                        }, { merge: true });
                        console.log(`Firestore: Ordine PRINCIPALE ${orderIdFromMetadata} aggiornato/creato come 'Pagato'.`);

                        // Aggiorna il SOTTO-ORDINE nella collezione 'vendor_orders'
                        if (vendorIdFromMetadata) {
                            await db.collection('vendor_orders').doc(vendorIdFromMetadata).collection('orders').doc(orderIdFromMetadata).set({
                                status: 'Pagato',
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
                        
                        // >>> INVIA NOTIFICA PUSH AL CLIENTE (Il "Postino Vercel" in azione!) <<<
                        if (customerUserIdFromMetadata) {
                            await sendPushNotification(
                                customerUserIdFromMetadata,
                                '✅ Pagamento Riuscito!',
                                `Il tuo pagamento per l'ordine #${orderIdFromMetadata} è stato completato.`,
                                { route: '/orders', orderId: orderIdFromMetadata } // Dati per la navigazione
                            );
                        }
                        // >>> FINE NOTIFICA <<<

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
                const customerUserIdFailed = paymentIntentFailed.metadata?.customerUserId; // <<< NUOVO: ID UTENTE DAL METADATA

                if (orderIdFailed && db) {
                    try {
                        // Aggiorna l'ordine PRINCIPALE
                        await db.collection('orders').doc(orderIdFailed).set({
                            status: 'Pagamento Fallito',
                            paymentStatus: 'Fallito',
                            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                            stripePaymentIntentId: paymentIntentFailed.id,
                            lastPaymentError: paymentIntentFailed.last_payment_error?.message || 'Errore sconosciuto'
                        }, { merge: true });
                        console.log(`Firestore: Ordine PRINCIPALE ${orderIdFailed} aggiornato/creato come 'Pagamento Fallito'.`);

                        // Aggiorna il SOTTO-ORDINE
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

                        // >>> INVIA NOTIFICA PUSH AL CLIENTE <<<
                        if (customerUserIdFailed) {
                            await sendPushNotification(
                                customerUserIdFailed,
                                '❌ Pagamento Fallito',
                                `Il tuo pagamento per l'ordine #${orderIdFailed} non è riuscito. Riprova.`,
                                { route: '/orders', orderId: orderIdFailed }
                            );
                        }
                        // >>> FINE NOTIFICA <<<

                    } catch (updateError) {
                        console.error(`Firestore: Errore critico nell'aggiornare gli ordini falliti (principale o sotto-ordine) ${orderIdFailed}:`, updateError.message);
                    }
                } else {
                    console.warn(`Webhook: PaymentIntent fallito ma OrderId non trovato nei metadata o DB non inizializzato per l'ID ${paymentIntentFailed.id}.`);
                }
                break;
            
            // >>> AGGIUNGI QUI ALTRE LOGICHE PER ALTRI TIPI DI EVENTI DI STRIPE SE SERVE <<<
            // case 'checkout.session.completed':
            //     // Logica per gestire sessioni di checkout completate (se usi Stripe Checkout)
            //     break;
            // case 'customer.subscription.created':
            //     // Logica per abbonamenti
            //     break;
            // <<< FINE ALTRI TIPI DI EVENTI >>>

            default:
                console.log(`Unhandled event type ${event.type} received.`);
        }

        res.status(200).json({ received: true });
    } else {
        res.setHeader('Allow', 'POST, OPTIONS');
        res.status(405).end('Method Not Allowed');
    }
};
