const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
// Adicionado 'onCall' para a nova função
const { onRequest, onCall } = require("firebase-functions/v2/https"); 
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();

// --- FUNÇÃO 1: Lembrete para o CLIENTE (Agendada) ---
exports.enviarLembretesAutomaticos = onSchedule({
  schedule: "every 60 minutes",
  timeZone: "America/Sao_Paulo",
  region: "southamerica-east1",
  secrets: ["EVOLUTION_URL", "EVOLUTION_APIKEY", "EVOLUTION_INSTANCE"],
}, async (event) => {
  console.log("Lembrete Cliente: Executando a função de lembretes automáticos.");

  const EVOLUTION_URL = process.env.EVOLUTION_URL;
  const EVOLUTION_API_KEY = process.env.EVOLUTION_APIKEY;
  const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;

  const amanha = new Date();
  amanha.setDate(amanha.getDate() + 1);
  const ano = amanha.getFullYear();
  const mes = amanha.getMonth();
  const dia = amanha.getDate();

  const inicioLembrete = new Date(ano, mes, dia, 0, 0, 0);
  const fimLembrete = new Date(ano, mes, dia, 23, 59, 59);

  const agendamentosRef = db.collectionGroup("appointments");
  const q = agendamentosRef
    .where("lembreteEnviado", "==", null)
    .where("dateTime", ">=", inicioLembrete)
    .where("dateTime", "<=", fimLembrete);

  const snapshot = await q.get();

  if (snapshot.empty) {
    console.log("Lembrete Cliente: Nenhum agendamento para amanhã.");
    return null;
  }

  for (const doc of snapshot.docs) {
    const agendamento = doc.data();
    const { clientName, clientPhone, serviceName, dateTime, barberName, barberPhone } = agendamento;

    if (!clientPhone) { continue; }

    const numeroLimpo = `55${String(clientPhone).replace(/\D/g, "")}`;
    const dataAgendamento = dateTime.toDate();
    
    const opcoesHora = { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false };
    const opcoesData = { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' };
    
    const horaFormatada = dataAgendamento.toLocaleTimeString('pt-BR', opcoesHora);
    const diaFormatado = dataAgendamento.toLocaleDateString('pt-BR', opcoesData);

let mensagem = `Olá, ${clientName}! Lembrete do seu agendamento para amanhã.\n\n` +
               `*Serviço:* ${serviceName}\n` +
               `*Profissional:* ${barberName}\n` +
               `*Data:* ${diaFormatado} às ${horaFormatada}\n\n`;

if (barberPhone) {
    mensagem += `Se não puder comparecer, por favor avise o(a) ${barberName} pelo número: ${barberPhone}.\nAgradecemos!`;
} else {
    mensagem += `\nEsperamos por você!`;
}

mensagem += `\n\n*Esta é uma mensagem automática, por favor, não responda.*`;

console.log(mensagem);


    try {
      const payload = {
        number: numeroLimpo,
        text: mensagem 
      };
      
      await axios.post( `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`, payload, { headers: { "apikey": EVOLUTION_API_KEY } });
      console.log(`Lembrete Cliente: Enviado para ${clientName}.`);
      await doc.ref.update({ lembreteEnviado: true });
    } catch (error) {
      console.error(`Lembrete Cliente: Falha ao enviar para ${clientName}:`, error.response ? error.response.data : error.message);
    }
  }
  return null;
});


// --- FUNÇÃO 2: Notificação para o BARBEIRO (Tempo Real) ---
exports.notificarBarbeiroNovoAgendamento = onDocumentCreated({
    document: "users/{userId}/appointments/{appointmentId}",
    region: "southamerica-east1",
    secrets: ["EVOLUTION_URL", "EVOLUTION_APIKEY", "EVOLUTION_INSTANCE"],
}, async (event) => {
    console.log("Notificação Barbeiro: Novo agendamento detectado.");
    
    const snapshot = event.data;
    if (!snapshot) { return; }

    const agendamento = snapshot.data();
    const { clientName, clientPhone, serviceName, dateTime, barberPhone, barberName } = agendamento;

    if (!barberPhone) {
        console.log(`Notificação Barbeiro: O profissional ${barberName} não tem telefone.`);
        return;
    }

    const EVOLUTION_URL = process.env.EVOLUTION_URL;
    const EVOLUTION_API_KEY = process.env.EVOLUTION_APIKEY;
    const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;

    const dataAgendamento = dateTime.toDate();
    const opcoesHora = { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false };
    const opcoesData = { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' };
    const horaFormatada = dataAgendamento.toLocaleTimeString('pt-BR', opcoesHora);
    const diaFormatado = dataAgendamento.toLocaleDateString('pt-BR', opcoesData);

    const mensagem = `📢 *Novo Agendamento Recebido!* 📢\n\n*Cliente:* ${clientName}\n*Contato:* ${clientPhone}\n*Serviço:* ${serviceName}\n*Quando:* Dia ${diaFormatado} às ${horaFormatada}`;
    const numeroLimpo = `55${String(barberPhone).replace(/\D/g, "")}`;

    try {
        const payload = {
            number: numeroLimpo,
            text: mensagem
        };

        await axios.post(`${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`, payload, { headers: { "apikey": EVOLUTION_API_KEY } });
        console.log(`Notificação Barbeiro: Alerta enviado para ${barberName}.`);
    } catch (error) {
        console.error(`Notificação Barbeiro: Falha ao notificar ${barberName}:`, error.response ? error.response.data : error.message);
    }
});


// --- FUNÇÃO 3: Ouvinte de Pagamentos do Stripe (Webhook) ---
exports.stripeWebhook = onRequest({
    region: "southamerica-east1",
    secrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
}, async (request, response) => {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const sig = request.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;

    try {
        event = stripe.webhooks.constructEvent(request.rawBody, sig, webhookSecret);
    } catch (err) {
        console.error(`Webhook Stripe - Erro na assinatura: ${err.message}`);
        response.status(400).send(`Webhook Error: ${err.message}`);
        return;
    }
  
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const clientReferenceId = session.client_reference_id;

        if (!clientReferenceId) {
            console.error("Webhook Stripe - Erro: client_reference_id não encontrado na sessão.");
            response.status(400).send("client_reference_id ausente.");
            return;
        }

        console.log(`Webhook Stripe: Pagamento recebido para o usuário: ${clientReferenceId}`);

        try {
            const userRef = db.collection('users').doc(clientReferenceId);
            await userRef.update({
                subscription: {
                    status: 'active',
                    plan: 'premium',
                    stripeCustomerId: session.customer,
                    lastPayment: admin.firestore.FieldValue.serverTimestamp()
                }
            });
            console.log(`Webhook Stripe: Assinatura do usuário ${clientReferenceId} ativada com sucesso!`);
        } catch (dbError) {
            console.error("Webhook Stripe - Erro ao atualizar o usuário no Firestore:", dbError);
            response.status(500).send("Erro interno ao atualizar assinatura.");
            return;
        }
    }

    response.status(200).send({ received: true });
});

// --- FUNÇÃO 4 (NOVA): Gerador de Link para o Portal do Cliente Stripe ---
exports.createStripePortalLink = onCall({
    region: "southamerica-east1",
    secrets: ["STRIPE_SECRET_KEY"],
}, async (request) => {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    
    // 1. Verifica se o usuário está autenticado
    if (!request.auth) {
        throw new functions.https.HttpsError(
            "unauthenticated",
            "Você precisa estar logado."
        );
    }

    try {
        const userId = request.auth.uid;
        const userDoc = await db.collection("users").doc(userId).get();
        
        // 2. Procura o ID dentro do objeto 'subscription'
        const stripeCustomerId = userDoc.data()?.subscription?.stripeCustomerId;

        if (!stripeCustomerId) {
            throw new functions.https.HttpsError(
                "not-found",
                "ID de cliente do Stripe não encontrado no documento do usuário."
            );
        }

        // 3. Define a URL para onde o cliente voltará após sair do portal
        const returnUrl = request.data.returnUrl || "https://barbeariagenda.com.br/dashboard.html"; // IMPORTANTE: Mude para sua URL de produção

        // 4. Cria a sessão do portal no Stripe
        const session = await stripe.billingPortal.sessions.create({
            customer: stripeCustomerId,
            return_url: returnUrl,
        });
        
        // 5. Retorna o link seguro para o frontend
        return { url: session.url };

    } catch (error) {
        console.error("Portal Stripe - Erro ao criar sessão:", error);
        throw new functions.https.HttpsError("internal", "Não foi possível criar o link do portal.");
    }
});
// --- FUNÇÃO 5 (NOVA): Lembrete de Retorno para Clientes Inativos ---
exports.enviarLembreteDeRetorno = onSchedule({
    // Roda todo dia às 9:00 da manhã
    schedule: "every day 09:00",
    timeZone: "America/Sao_Paulo",
    region: "southamerica-east1",
    secrets: ["EVOLUTION_URL", "EVOLUTION_APIKEY", "EVOLUTION_INSTANCE"],
}, async (event) => {
    console.log("Iniciando verificação de clientes inativos para reengajamento.");

    const EVOLUTION_URL = process.env.EVOLUTION_URL;
    const EVOLUTION_API_KEY = process.env.EVOLUTION_APIKEY;
    const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;

    // Calcula a data de 30 dias atrás a partir de agora
    const fortyDaysAgo = new Date();
    fortyDaysAgo.setDate(fortyDaysAgo.getDate() - 30);
    const fortyDaysAgoTimestamp = admin.firestore.Timestamp.fromDate(fortyDaysAgo);

    try {
        // Busca todos os clientes de todos os usuários (barbearias)
        const clientsSnapshot = await db.collectionGroup("clients").get();

        if (clientsSnapshot.empty) {
            console.log("Nenhum cliente encontrado para verificar.");
            return null;
        }

        const promises = [];

        clientsSnapshot.forEach(doc => {
            const client = doc.data();
            const clientRef = doc.ref;
            const ownerId = clientRef.parent.parent.id; // ID do dono da barbearia

            // Condições para enviar a mensagem:
            // 1. Tem uma data do último agendamento.
            // 2. Essa data é anterior a 40 dias atrás.
            // 3. Nenhuma mensagem de retorno foi enviada ainda para este período de inatividade.
            if (client.lastAppointmentDate && client.lastAppointmentDate < fortyDaysAgoTimestamp && !client.winbackMessageSent) {
                
                const clientName = client.name;
                const clientPhone = client.phone;
                // ATENÇÃO: Verifique se este é o seu domínio correto
                const bookingLink = `https://barbeariagenda.com.br/booking.html?user=${ownerId}`; 

                if (!clientPhone) return;

                const numeroLimpo = `55${String(clientPhone).replace(/\D/g, "")}`;
                const mensagem = `Olá, ${clientName}! Sentimos sua falta. Já faz um tempo desde sua última visita! Que tal agendar um novo horário e dar um trato no visual?\n\nAgende aqui: ${bookingLink}`;

                const sendPromise = axios.post(
                    `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
                    { number: numeroLimpo, text: mensagem },
                    { headers: { "apikey": EVOLUTION_API_KEY } }
                ).then(() => {
                    console.log(`Mensagem de retorno enviada para ${clientName}.`);
                    // Marca que a mensagem foi enviada para não enviar de novo
                    return clientRef.update({ winbackMessageSent: true });
                }).catch(error => {
                    console.error(`Falha ao enviar mensagem de retorno para ${clientName}:`, error.response ? error.response.data : error.message);
                });

                promises.push(sendPromise);
            }
        });

        await Promise.all(promises);
        console.log("Verificação de clientes inativos concluída.");
        return null;

    } catch (error) {
        console.error("Erro geral na função de lembrete de retorno:", error);
        return null;
    }
});
// --- FUNÇÃO 5 (NOVA): Lembrete de Retorno para Clientes Inativos ---
exports.enviarLembreteDeRetorno = onSchedule({
    // Roda todo dia às 9:00 da manhã
    schedule: "every day 09:00",
    timeZone: "America/Sao_Paulo",
    region: "southamerica-east1",
    secrets: ["EVOLUTION_URL", "EVOLUTION_APIKEY", "EVOLUTION_INSTANCE"],
}, async (event) => {
    console.log("Iniciando verificação de clientes inativos (30 dias) para reengajamento.");

    const EVOLUTION_URL = process.env.EVOLUTION_URL;
    const EVOLUTION_API_KEY = process.env.EVOLUTION_APIKEY;
    const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;

    // --- LÓGICA ALTERADA PARA 30 DIAS ---
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoTimestamp = admin.firestore.Timestamp.fromDate(thirtyDaysAgo);

    try {
        const clientsSnapshot = await db.collectionGroup("clients").get();

        if (clientsSnapshot.empty) {
            console.log("Nenhum cliente encontrado para verificar.");
            return null;
        }

        const promises = [];

        clientsSnapshot.forEach(doc => {
            const client = doc.data();
            const clientRef = doc.ref;
            const ownerId = clientRef.parent.parent.id;

            // Condições para enviar a mensagem:
            // 1. Tem uma data do último agendamento.
            // 2. Essa data é anterior a 30 dias atrás.
            // 3. Nenhuma mensagem de retorno foi enviada ainda para este período.
            if (client.lastAppointmentDate && client.lastAppointmentDate < thirtyDaysAgoTimestamp && !client.winbackMessageSent) {
                
                const clientName = client.name;
                const clientPhone = client.phone;
                const bookingLink = `https://barbeariagenda.com.br/booking.html?user=${ownerId}`;

                if (!clientPhone) return;

                const numeroLimpo = `55${String(clientPhone).replace(/\D/g, "")}`;
                const mensagem = `Olá, ${clientName}! Sentimos sua falta. Já faz um tempo desde sua última visita! Que tal agendar um novo horário e dar um trato no visual?\n\nAgende aqui: ${bookingLink}`;

                const sendPromise = axios.post(
                    `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
                    { number: numeroLimpo, text: mensagem },
                    { headers: { "apikey": EVOLUTION_API_KEY } }
                ).then(() => {
                    console.log(`Mensagem de retorno enviada para ${clientName}.`);
                    // Marca que a mensagem foi enviada para não enviar de novo
                    return clientRef.update({ winbackMessageSent: true });
                }).catch(error => {
                    console.error(`Falha ao enviar mensagem de retorno para ${clientName}:`, error.response ? error.response.data : error.message);
                });

                promises.push(sendPromise);
            }
        });

        await Promise.all(promises);
        console.log("Verificação de clientes inativos concluída.");
        return null;

    } catch (error) {
        console.error("Erro geral na função de lembrete de retorno:", error);
        return null;
    }
});