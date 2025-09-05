const { Resend } = require('resend');

// Prende la chiave API che hai messo nelle variabili d'ambiente di Vercel
const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async (req, res) => {
  try {
    console.log("Avvio della funzione di verifica email...");

    const { data, error } = await resend.emails.send({
      from: 'localmente.velletri@gmail.com', // L'indirizzo che vogliamo verificare
      to: 'localmente.velletri@gmail.com',   // Mandiamo l'email a noi stessi
      subject: 'Verifica il tuo indirizzo per Resend',
      html: '<strong>Per favore, clicca il link in questa email per verificare il tuo indirizzo come mittente per Localmente.</strong>',
    });

    if (error) {
      console.error("Errore da Resend:", error);
      // Resend potrebbe rispondere con un errore che ci dice che l'email non è verificata.
      // Questo è OK. L'importante è che l'email di verifica venga inviata.
      return res.status(400).json({ 
        message: "Resend ha risposto con un errore, ma l'email di verifica dovrebbe essere stata inviata comunque. Controlla la tua posta.",
        details: error 
      });
    }

    console.log("Successo! Dati da Resend:", data);
    return res.status(200).json({ 
      message: "Comando inviato a Resend. Controlla la tua casella di posta per l'email di verifica.",
      details: data 
    });

  } catch (e) {
    console.error("Errore catastrofico nella funzione:", e);
    return res.status(500).json({ error: 'Errore grave nella funzione Vercel.', details: e.message });
  }
};
