// File: api/update-vehicle-status.js
const admin = require('firebase-admin');

// Inizializzazione Firebase
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } catch (error) {
    console.error('ERRORE INIZIALIZZAZIONE FIREBASE (CRON):', error);
  }
}
const db = admin.firestore();

module.exports = async (req, res) => {
  console.log("CRON JOB: Avvio aggiornamento stato veicoli.");

  try {
    const now = admin.firestore.Timestamp.now();

    // 1. Trova tutte le prenotazioni di noleggio ATTIVE in questo momento
    // Una prenotazione è attiva se startDateTime <= now E endDateTime > now.
    const activeBookingsSnapshot = await db.collection('bookings')
      .where('type', '==', 'noleggio')
      .where('status', '==', 'confirmed') // Consideriamo solo le confermate
      .where('startDateTime', '<=', now)
      .get();

    const rentedVehicleIds = new Set();
    activeBookingsSnapshot.forEach(doc => {
      const booking = doc.data();
      if (booking.endDateTime.toDate() > now.toDate()) { // Se la prenotazione non è ancora scaduta
        rentedVehicleIds.add(booking.serviceId); // serviceId è l'ID del veicolo
      }
    });

    // 2. Prendi TUTTI i veicoli dal database
    const allVehiclesSnapshot = await db.collection('noleggio_veicoli').get();
    
    const batch = db.batch();
    let updatesCounter = 0;

    // 3. Per ogni veicolo, controlla e aggiorna lo stato se necessario
    for (const doc of allVehiclesSnapshot.docs) { // Uso for...of per le async
      const vehicleId = doc.id;
      const currentStatus = doc.data().status;
      const vehicleRef = db.collection('noleggio_veicoli').doc(vehicleId);
      
      // Caso 1: Il veicolo è attualmente prenotato (dall'app)
      if (rentedVehicleIds.has(vehicleId)) {
        if (currentStatus !== 'rented') {
          // Se era in cleaning o maintenance, non lo forziamo a 'rented'
          // a meno che non fosse 'available'. Questa logica va affinata con più stati.
          // Per ora, lo mettiamo a 'rented' se non lo è già, ignorando cleaning/maintenance.
          // In uno scenario più complesso, potremmo non voler sovrascrivere stati manuali.
          // Per la tua logica "app ha segnato rientrata e pulita anche se non lo è",
          // significa che il cron job deve avere la precedenza sulle prenotazioni attive.
          batch.update(vehicleRef, { status: 'rented', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          updatesCounter++;
          console.log(`Veicolo ${vehicleId} (era ${currentStatus}) impostato su 'rented' da prenotazione attiva.`);
        }
      } 
      // Caso 2: Il veicolo NON è attualmente prenotato (dall'app)
      else {
        // Se il veicolo era 'rented', significa che la prenotazione è finita.
        // Lo stato deve passare a 'cleaning' per l'intervento manuale.
        if (currentStatus === 'rented') {
          batch.update(vehicleRef, { status: 'cleaning', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          updatesCounter++;
          console.log(`Veicolo ${vehicleId} (era 'rented') impostato su 'cleaning' (prenotazione scaduta).`);
        } 
        // Se non è noleggiato e non è in cleaning/maintenance, deve essere disponibile.
        // Questo catch-all ripristina 'available' se non ci sono altre condizioni.
        else if (currentStatus !== 'cleaning' && currentStatus !== 'maintenance' && currentStatus !== 'available') {
          // Questo caso può accadere se uno stato sconosciuto è stato impostato
          batch.update(vehicleRef, { status: 'available', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          updatesCounter++;
          console.log(`Veicolo ${vehicleId} (stato anomalo ${currentStatus}) impostato su 'available'.`);
        }
        // Se è già 'available', 'cleaning' o 'maintenance', non facciamo nulla
      }
    }

    // 4. Esegui gli aggiornamenti solo se ce ne sono
    if (updatesCounter > 0) {
      await batch.commit();
      console.log(`CRON JOB: Aggiornamento completato. ${updatesCounter} stati modificati.`);
      res.status(200).send(`Stato di ${updatesCounter} veicoli aggiornato.`);
    } else {
      console.log("CRON JOB: Nessun aggiornamento di stato necessario.");
      res.status(200).send('Nessun aggiornamento di stato necessario.');
    }

  } catch (error) {
    console.error('ERRORE nel cron job updateVehicleStatus:', error);
    res.status(500).send(`Errore durante l'esecuzione del cron job: ${error.message}`);
  }
};
