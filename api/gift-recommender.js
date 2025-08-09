// api/gift-recommender.js
import { GoogleGenerativeAI } from "@google/generative-ai";
import products from "../data/products.json";

// Funzione per filtrare prodotti esclusi
function filterProducts(allProducts) {
  return allProducts.filter(p => 
    p && p.name && 
    (!p.category || !["Esclusa", "Proibita"].includes(p.category))
  );
}

export default async function handler(req, res) {
  try {
    const { userQuery } = req.body;

    console.log("Carico un ampio set di prodotti dal catalogo...");
    const filteredProducts = filterProducts(products);
    console.log(`Filtrati ${filteredProducts.length} prodotti validi.`);

    // Inizializzo Gemini
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

    const prompt = `
      Sei un assistente per la ricerca regali.
      Il cliente scrive: "${userQuery}".
      Cerca i regali più pertinenti dal seguente catalogo:
      ${filteredProducts.map(p => `- ${p.name} (${p.category || "Generale"})`).join("\n")}
      Rispondi solo con una lista di nomi di prodotti dal catalogo, max 6, ordinati per pertinenza.
    `;

    let suggestions = [];

    try {
      const model = genAI.getGenerativeModel({ model: "gemini-pro" });
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();

      // Estraggo solo i prodotti presenti nel catalogo
      suggestions = filteredProducts.filter(p =>
        responseText.toLowerCase().includes(p.name.toLowerCase())
      ).slice(0, 6);

    } catch (aiError) {
      console.error("ERRORE DALL'AI, attivando il Piano B:", aiError);
    }

    // Piano B: prodotti casuali coerenti
    if (suggestions.length === 0) {
      const shuffled = filteredProducts.sort(() => 0.5 - Math.random());
      suggestions = shuffled.slice(0, 6);
    }

    res.status(200).json({ products: suggestions });

  } catch (error) {
    console.error("Errore generale:", error);
    res.status(500).json({ error: "Qualcosa è andato storto." });
  }
}
