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
            // Tenta di decodificare da Base64 se il parsing JSON diretto fallisce
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


// --- Funzione per inviare notifiche push (invariata) ---
async function sendPushNotification(userId, title, body, data = {}, notificationType) {
    if (!db || !messaging || !userId) {
        console.error("Cannot send notification: DB, Messaging, or userId not available.");
        return;
    }

    try {
        const userPrefsDoc = await db.collection('users').doc(userId).collection('preferences').doc('notification_settings').get();
        const userPrefs = userPrefsDoc.data();

        const globalPushEnabled = userPrefs?.receivePushNotifications ?? false;
        if (!globalPushEnabled) {
            console.log(`Global push notifications disabled for user ${userId}. Notification not sent.`);
            return;
        }

        let specificNotificationEnabled = true;
        if (notificationType === 'payment') {
            specificNotificationEnabled = userPrefs?.receivePaymentNotifications ?? true; 
        } else if (notificationType === 'wish_response') { 
            specificNotificationEnabled = userPrefs?.receiveWishNotifications ?? true;
        } else if (notificationType === 'new_chat_message') { 
            specificNotificationEnabled = userPrefs?.receiveChatMessageNotifications ?? true;
        } else if (notificationType === 'favorite_vendor_new_product') {
            specificNotificationEnabled = userPrefs?.receiveFavoriteVendorNewProducts ?? true;
        } else if (notificationType === 'favorite_vendor_special_offer') {
            specificNotificationEnabled = userPrefs?.receiveFavoriteVendorSpecialOffers ?? true;
        }
        
        if (!specificNotificationEnabled) {
            console.log(`Specific notification type "${notificationType}" disabled for user ${userId}. Notification not sent.`);
            return;
        }

    } catch (e) {
        console.error(`Error checking notification preferences for user ${userId}:`, e);
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
// --- Fine Funzione sendPushNotification ---


// --- Funzione per impostare gli header CORS (AGGIUNTO Access-Control-Allow-Origin: *) ---
function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
    res.setHeader('Access-Control-Max-Age', '86400');
}


module.exports = async (req, res) => {
  console.log("----- create-payment-intent function started! -----");
  
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    // Aggiungi una verifica che Firebase DB sia inizializzato
    if (!db) {
        console.error("Firebase Firestore DB non è stato inizializzato. Impossibile creare Payment Intent o inviare notifiche.");
        return res.status(500).json({ error: 'Server configuration error: Firebase DB not initialized.' });
    }

    try {
      const { 
        // Campi esistenti per le notifiche
        sendNotification,
        notificationTitle,
        notificationBody,
        notificationData,
        notificationType,

        // Campi NUOVI per il calcolo sicuro del pagamento (PREFERITO)
        items,               // Array di { productId, quantity, price, vendorId, options } - Questo NON sarà più inviato per guest
        tempGuestCartRef,    // NUOVO: Riferimento temporaneo al carrello ospite in Firestore
        shipping,            // Costo di spedizione forfettario
        vendorId,            // L'ID del venditore (può essere vuoto se consolidated marketplace)
        isGuest,             // Flag booleano per checkout ospite
        guestData,           // Oggetto con i dettagli di contatto/consegna dell'ospite

        // Campi esistenti per mantenere la compatibilità (LEGACY, meno sicuro)
        amount: legacyAmount, // Rinominato per evitare conflitti
        currency: legacyCurrency, // Rinominato per evitare conflitti
        description,
        stripeAccountId,     // Per account connessi (Connected Accounts)
        applicationFeeAmount, // Per commissioni dell'applicazione su Connected Accounts
        metadata,            // Metadati esistenti
        customerUserId       // Per utenti loggati
      } = req.body;

      // --- PATH 1: Invia solo una notifica ---
      if (sendNotification) {
          if (!customerUserId) {
            return res.status(400).json({ error: 'customerUserId è richiesto per inviare notifiche.' });
          }
          console.log(`Richiesta di invio notifica per l'utente ${customerUserId}.`);
          await sendPushNotification(
              customerUserId,
              notificationTitle || "Notifica da Civora",
              notificationBody || "Controlla l'app per i dettagli!",
              notificationData || {},
              notificationType 
          );
          return res.status(200).json({ message: 'Notifica inviata con successo.' });
      }

      // --- PATH 2: Crea un Payment Intent ---
      let finalAmount = 0;
      let finalCurrency = 'eur'; // Valuta predefinita per il marketplace
      let paymentIntentMetadata = { ...metadata }; // Inizia con eventuali metadati esistenti

      // Inizializzazione per recupero dati venditore
      let fetchedVendorStoreName = 'Negozio Sconosciuto';
      let fetchedStripeAccountId = stripeAccountId; 
      let fetchedApplicationFeeAmount = applicationFeeAmount; 
      let orderItems = []; // Per tenere traccia degli item per il calcolo e i metadati

      // Recupera i dettagli del venditore (per nome negozio e potenziali dettagli di account connesso/commissioni)
      // Questo blocco ora gestisce anche il caso di più venditori (vendorId dalla root può essere null)
      if (vendorId && db) { // Solo se vendorId è fornito a livello di root (singleVendorExpress)
          const vendorDoc = await db.collection('vendors').doc(vendorId).get();
          if (vendorDoc.exists) {
              const vendorData = vendorDoc.data();
              fetchedVendorStoreName = vendorData.store_name || fetchedVendorStoreName;
              if (!fetchedStripeAccountId && vendorData.stripeAccountId) { 
                fetchedStripeAccountId = vendorData.stripeAccountId;
              }
          } else {
              console.warn(`Venditore root ${vendorId} non trovato. Proseguo con il nome del venditore predefinito.`);
          }
      }
      paymentIntentMetadata.vendorId = vendorId; // Salva l'ID del venditore root nei metadati
      paymentIntentMetadata.vendorStoreName = fetchedVendorStoreName; // Salva il nome del venditore root nei metadati

      // --- NUOVA LOGICA PER GESTIRE GLI ARTICOLI DEL CARRELLO, ORA RECUPERATI DA FIRESTORE SE OSPITE ---
      if (isGuest && tempGuestCartRef) {
          console.log(`Guest order detected with tempGuestCartRef: ${tempGuestCartRef}. Fetching cart items from Firestore.`);
          const tempCartDoc = await db.collection('temp_guest_carts').doc(tempGuestCartRef).get();
          if (!tempCartDoc.exists) {
              return res.status(400).json({ error: 'Carrello ospite temporaneo non trovato.' });
          }
          orderItems = tempCartDoc.data().items; // Recupera gli items dal documento temporaneo
          paymentIntentMetadata.tempGuestCartRef = tempGuestCartRef; // Salva il riferimento per la finalizzazione
          if (!Array.isArray(orderItems) || orderItems.length === 0) {
            return res.status(400).json({ error: 'Articoli nel carrello ospite temporaneo non validi o vuoti.' });
          }
          // Aggiungi guestData ai metadati
          if (guestData) {
              paymentIntentMetadata.guestName = guestData.name;
              paymentIntentMetadata.guestSurname = guestData.surname;
              paymentIntentMetadata.guestAddress = guestData.address;
              paymentIntentMetadata.guestCity = guestData.city;
              paymentIntentMetadata.guestCap = guestData.cap;
              paymentIntentMetadata.guestProvince = guestData.province;
              paymentIntentMetadata.guestCountry = guestData.country;
              paymentIntentMetadata.guestPhone = guestData.phone;
              paymentIntentMetadata.guestEmail = guestData.email;
          }

      } else if (items && Array.isArray(items) && items.length > 0) {
          // Questo percorso è per utenti loggati che inviano ancora gli item direttamente (meno sicuro, da aggiornare)
          orderItems = items;
          if (customerUserId) {
              paymentIntentMetadata.customerUserId = customerUserId;
              paymentIntentMetadata.isGuestOrder = 'false';
          } else {
              return res.status(400).json({ error: 'ID cliente richiesto quando vengono forniti gli articoli direttamente.' });
          }
      } else {
          // Percorso di fallback se non ci sono né tempGuestCartRef né items
          return res.status(400).json({ error: 'Mancano gli articoli del carrello o il riferimento temporaneo per il Payment Intent.' });
      }

      // Calcolo finale del subtotale basato sugli orderItems recuperati/forniti
      let calculatedSubtotal = 0;
      const orderItemsForMetadata = []; // Dettagli item per i metadati

      for (const item of orderItems) {
          if (!item.vendorId || typeof item.vendorId !== 'string' || item.vendorId.trim() === '') {
              return res.status(400).json({ error: `ID venditore mancante o non valido per un articolo del carrello: ${item.productId}` });
          }

          const productRef = db.collection('offers').doc(item.productId);
          const productSnap = await productRef.get();

          if (!productSnap.exists) {
              return res.status(400).json({ error: `Prodotto non trovato nel database: ${item.productId}` });
          }
          const productData = productSnap.data();
          const unitPrice = productData.price; // Prezzo dal DB (validazione lato server)
          const quantity = item.quantity;

          if (unitPrice <= 0 || quantity <= 0) {
              return res.status(400).json({ error: `Quantità o prezzo del prodotto non validi per ${productData.productName}` });
          }
          calculatedSubtotal += unitPrice * quantity;
          orderItemsForMetadata.push({
              productId: item.productId,
              productName: productData.productName,
              price: unitPrice,
              quantity: quantity,
              imageUrl: productData.productImageUrls ? productData.productImageUrls[0] : (productData.productImageUrl || ''),
              options: item.options || {}, // Includi le opzioni (varianti)
              vendorId: item.vendorId // IMPORTANTE: Mantiene il vendorId specifico dell'articolo
          });
      }

      finalAmount = calculatedSubtotal + (Number(shipping) || 0);

      // NON INSERIRE orderItemsForMetadata in Stripe metadata per il limite di caratteri!
      // Verranno recuperati tramite tempGuestCartRef.

      // VALIDAZIONE FINALE DELL'IMPORTO
      if (finalAmount <= 0) {
          return res.status(400).json({ error: 'L\'ammontare totale dell\'ordine deve essere positivo.' });
      }

      const params = {
        amount: Math.round(finalAmount * 100), // Importo in centesimi
        currency: finalCurrency,
        payment_method_types: ['card'],
        description: description || `Ordine per ${fetchedVendorStoreName}`,
        metadata: paymentIntentMetadata, // Usa i metadati preparati (ora senza cartItems)
      };

      // Gestione per Account Connessi (se fetchedStripeAccountId è disponibile)
      if (fetchedStripeAccountId) {
        params.transfer_data = {
          destination: fetchedStripeAccountId,
        };
        if (fetchedApplicationFeeAmount) {
          params.application_fee_amount = parseInt(fetchedApplicationFeeAmount);
        }
      }

      const paymentIntent = await stripe.paymentIntents.create(params);

      res.status(200).json({ clientSecret: paymentIntent.client_secret });

    } catch (error) {
      console.error('Errore in create-payment-intent:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  } else {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).end('Method Not Allowed');
  }
};
