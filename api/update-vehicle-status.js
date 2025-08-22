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
    const activeBookingsSnapshot = await db.collection('bookings')
      .where('type', '==', 'noleggio')
      .where('status', '==', 'confirmed')
      .where('startDateTime', '<=', now)
      .get();

    const rentedVehicleIds = new Set();
    activeBookingsSnapshot.forEach(doc => {
      const booking = doc.data();
      // Controlla se la data di fine è nel futuro
      if (booking.endDateTime.toDate() > now.toDate()) {
        rentedVehicleIds.add(booking.serviceId); // serviceId è l'ID del veicolo
      }
    });

    // 2. Prendi TUTTI i veicoli
    const allVehiclesSnapshot = await db.collection('noleggio_veicoli').get();
    
    const batch = db.batch();
    let updatesCounter = 0;

    // 3. Per ogni veicolo, controlla e aggiorna lo stato se necessario
    allVehiclesSnapshot.forEach(doc => {
      const vehicleId = doc.id;
      const currentStatus = doc.data().status;
      
      if (rentedVehicleIds.has(vehicleId)) {
        // Questo veicolo dovrebbe essere 'rented'
        if (currentStatus !== 'rented') {
          const vehicleRef = db.collection('noleggio_veicoli').doc(vehicleId);
          batch.update(vehicleRef, { status: 'rented' });
          updatesCounter++;
          console.log(`Veicolo ${vehicleId} impostato su 'rented'.`);
        }
      } else {
        // Questo veicolo dovrebbe essere 'available'
        if (currentStatus !== 'available') {
          const vehicleRef = db.collection('noleggio_veicoli').doc(vehicleId);
          batch.update(vehicleRef, { status: 'available' });
          updatesCounter++;
          console.log(`Veicolo ${vehicleId} impostato su 'available'.`);
        }
      }
    });

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
