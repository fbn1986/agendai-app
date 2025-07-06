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

    let mensagem = `Olá, ${clientName}! Lembrete do seu agendamento!\n\n` +
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

// --- FUNÇÃO 4: Gerador de Link para o Portal do Cliente Stripe ---
exports.createStripePortalLink = onCall({
    region: "southamerica-east1",
    secrets: ["STRIPE_SECRET_KEY"],
}, async (request) => {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    
    if (!request.auth) {
        throw new functions.https.HttpsError(
            "unauthenticated",
            "Você precisa estar logado."
        );
    }

    try {
        const userId = request.auth.uid;
        const userDoc = await db.collection("users").doc(userId).get();
        
        const stripeCustomerId = userDoc.data()?.subscription?.stripeCustomerId;

        if (!stripeCustomerId) {
            throw new functions.https.HttpsError(
                "not-found",
                "ID de cliente do Stripe não encontrado no documento do usuário."
            );
        }

        const returnUrl = request.data.returnUrl || "https://agendaup.com.br/dashboard.html";

        const session = await stripe.billingPortal.sessions.create({
            customer: stripeCustomerId,
            return_url: returnUrl,
        });
        
        return { url: session.url };

    } catch (error) {
        console.error("Portal Stripe - Erro ao criar sessão:", error);
        throw new functions.https.HttpsError("internal", "Não foi possível criar o link do portal.");
    }
});

// --- FUNÇÃO 5: Lembrete de Retorno para Clientes Inativos ---
exports.enviarLembreteDeRetorno = onSchedule({
    schedule: "every day 09:00",
    timeZone: "America/Sao_Paulo",
    region: "southamerica-east1",
    secrets: ["EVOLUTION_URL", "EVOLUTION_APIKEY", "EVOLUTION_INSTANCE"],
}, async (event) => {
    console.log("Iniciando verificação de clientes inativos (30 dias) para reengajamento.");

    const EVOLUTION_URL = process.env.EVOLUTION_URL;
    const EVOLUTION_API_KEY = process.env.EVOLUTION_APIKEY;
    const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;

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

            if (client.lastAppointmentDate && client.lastAppointmentDate < thirtyDaysAgoTimestamp && !client.winbackMessageSent) {
                
                const clientName = client.name;
                const clientPhone = client.phone;
                const bookingLink = `https://agendaup.com.br/booking.html?user=${ownerId}`;

                if (!clientPhone) return;

                const numeroLimpo = `55${String(clientPhone).replace(/\D/g, "")}`;
                const mensagem = `Olá, ${clientName}! Sentimos sua falta. Já faz um tempo desde sua última visita! Que tal agendar um novo horário?\n\nAgende aqui: ${bookingLink}`;

                const sendPromise = axios.post(
                    `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
                    { number: numeroLimpo, text: mensagem },
                    { headers: { "apikey": EVOLUTION_API_KEY } }
                ).then(() => {
                    console.log(`Mensagem de retorno enviada para ${clientName}.`);
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

// ✨ ALTERAÇÃO: NOVA CLOUD FUNCTION PARA O PAINEL DE ADMIN
// --- FUNÇÃO 6: Conceder Acesso Vitalício (Ação de Admin) ---
exports.grantLifetimeAccess = onCall({
    region: "southamerica-east1",
}, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Ação não autorizada.");
    }
    const adminUid = request.auth.uid;
    const targetUserId = request.data.targetUserId;
    if (!targetUserId) {
         throw new HttpsError("invalid-argument", "O ID do usuário alvo não foi fornecido.");
    }
    try {
        const adminUserDoc = await db.collection("users").doc(adminUid).get();
        if (adminUserDoc.data()?.role !== 'admin') {
            throw new HttpsError("permission-denied", "Permissão negada.");
        }
        const targetUserRef = db.collection("users").doc(targetUserId);
        await targetUserRef.update({ isLifetime: true });
        console.log(`Acesso vitalício concedido para ${targetUserId} por ${adminUid}.`);
        return { success: true, message: "Acesso vitalício concedido com sucesso!" };
    } catch (error) {
        console.error("Erro ao conceder acesso vitalício:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Erro interno.");
    }
});


// --- FUNÇÃO 7: Revogar Acesso Vitalício (Ação de Admin) ---
exports.revokeLifetimeAccess = onCall({
    region: "southamerica-east1",
}, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Ação não autorizada.");
    }
    const adminUid = request.auth.uid;
    const targetUserId = request.data.targetUserId;
    if (!targetUserId) {
         throw new HttpsError("invalid-argument", "O ID do usuário alvo não foi fornecido.");
    }
    try {
        const adminUserDoc = await db.collection("users").doc(adminUid).get();
        if (adminUserDoc.data()?.role !== 'admin') {
            throw new HttpsError("permission-denied", "Permissão negada.");
        }
        const targetUserRef = db.collection("users").doc(targetUserId);
        await targetUserRef.update({
            isLifetime: admin.firestore.FieldValue.delete()
        });
        console.log(`Acesso vitalício revogado para ${targetUserId} por ${adminUid}.`);
        return { success: true, message: "Acesso vitalício revogado com sucesso!" };
    } catch (error) {
        console.error("Erro ao revogar acesso vitalício:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Erro interno.");
    }
});

// --- FUNÇÃO 8: Obter Métricas da Plataforma (Ação de Admin) ---
exports.getPlatformMetrics = onCall({
    region: "southamerica-east1",
}, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Ação não autorizada.");
    }
    const adminUid = request.auth.uid;
    try {
        const adminUserDoc = await db.collection("users").doc(adminUid).get();
        if (adminUserDoc.data()?.role !== 'admin') {
            throw new HttpsError("permission-denied", "Permissão negada.");
        }
        const usersSnapshot = await db.collection("users").get();
        let totalUsers = 0;
        let activeSubscribers = 0;
        let lifetimeUsers = 0;
        let trialUsers = 0;
        const fourteenDaysAgo = new Date();
        fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

        usersSnapshot.forEach(doc => {
            totalUsers++;
            const user = doc.data();
            if (user.isLifetime) {
                lifetimeUsers++;
            } else if (user.subscription?.status === 'active') {
                activeSubscribers++;
            } else if (user.createdAt && user.createdAt.toDate() > fourteenDaysAgo) {
                trialUsers++;
            }
        });
        return { totalUsers, activeSubscribers, lifetimeUsers, trialUsers };
    } catch (error) {
        console.error("Erro ao buscar métricas:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Erro ao buscar métricas.");
    }
});

// --- FUNÇÃO 9: Obter Usuários por Filtro (Ação de Admin) ---
exports.getUsersByFilter = onCall({
    region: "southamerica-east1",
}, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Ação não autorizada.");
    }
    const adminUid = request.auth.uid;
    const { filterType } = request.data;

    try {
        const adminUserDoc = await db.collection("users").doc(adminUid).get();
        if (adminUserDoc.data()?.role !== 'admin') {
            throw new HttpsError("permission-denied", "Permissão negada.");
        }

        const usersRef = db.collection("users");
        let querySnapshot;
        
        // CORREÇÃO: A lógica para 'trial' foi reescrita para evitar erros de índice.
        if (filterType === 'trial') {
            const allUsersSnapshot = await usersRef.get();
            const fourteenDaysAgo = new Date();
            fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

            const trialUsers = allUsersSnapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(user => {
                    const isSubscribed = user.subscription?.status === 'active';
                    const isLifetime = user.isLifetime === true;
                    const createdAt = user.createdAt?.toDate();
                    return !isSubscribed && !isLifetime && createdAt && createdAt > fourteenDaysAgo;
                });
            
            return { users: trialUsers };
        }

        // Lógica para os outros filtros
        switch (filterType) {
            case 'active':
                querySnapshot = await usersRef.where("subscription.status", "==", "active").get();
                break;
            case 'lifetime':
                querySnapshot = await usersRef.where("isLifetime", "==", true).get();
                break;
            case 'all':
            default:
                querySnapshot = await usersRef.get();
                break;
        }
        
        const users = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        return { users };

    } catch (error) {
        console.error(`Erro ao buscar usuários com filtro '${filterType}':`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Erro ao buscar usuários.");
    }
});
// ✨ NOVA FUNÇÃO DE ADMIN ✨
// --- FUNÇÃO 10: Deletar um Usuário (Ação de Admin) ---
exports.deleteUser = onCall({
    region: "southamerica-east1",
}, async (request) => {
    // 1. Verificação de autenticação
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Ação não autorizada. Você precisa estar logado.");
    }
    const adminUid = request.auth.uid;
    const { targetUserId } = request.data;

    // 2. Verificação de argumentos
    if (!targetUserId) {
         throw new HttpsError("invalid-argument", "O ID do usuário alvo não foi fornecido.");
    }

    // 3. Verificação de segurança: Admin não pode se auto-deletar
    if (adminUid === targetUserId) {
        throw new HttpsError("permission-denied", "Ação proibida. Você não pode deletar sua própria conta de administrador.");
    }

    try {
        // 4. Verificação de permissão: O chamador é um admin?
        const adminUserDoc = await db.collection("users").doc(adminUid).get();
        if (adminUserDoc.data()?.role !== 'admin') {
            throw new HttpsError("permission-denied", "Permissão negada. Apenas administradores podem deletar usuários.");
        }

        // 5. Execução da exclusão
        // Deleta do Firebase Authentication
        await admin.auth().deleteUser(targetUserId);
        console.log(`Usuário ${targetUserId} deletado do Authentication pelo admin ${adminUid}.`);

        // Deleta do Firestore
        await db.collection("users").doc(targetUserId).delete();
        console.log(`Documento do usuário ${targetUserId} deletado do Firestore pelo admin ${adminUid}.`);
        
        // NOTA: A exclusão de subcoleções (appointments, clients, etc.) não é automática.
        // Se necessário, uma lógica mais complexa pode ser adicionada aqui para deletar esses dados em cascata.
        // Por enquanto, estamos deletando o acesso e o perfil principal.

        return { success: true, message: "Usuário deletado permanentemente com sucesso!" };

    } catch (error) {
        console.error(`Falha ao deletar usuário ${targetUserId} pelo admin ${adminUid}:`, error);
        if (error instanceof HttpsError) {
            throw error;
        }
        // Trata erros comuns, como usuário não encontrado
        if (error.code === 'auth/user-not-found') {
             throw new HttpsError("not-found", "O usuário a ser deletado não foi encontrado no sistema de autenticação.");
        }
        throw new HttpsError("internal", "Ocorreu um erro interno ao tentar deletar o usuário.");
    }
});
// --- FUNÇÃO 6: Conceder Acesso Vitalício (Ação de Admin) ---
exports.grantLifetimeAccess = onCall({
    region: "southamerica-east1",
}, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Ação não autorizada.");
    }
    const adminUid = request.auth.uid;
    const targetUserId = request.data.targetUserId;
    if (!targetUserId) {
         throw new HttpsError("invalid-argument", "O ID do usuário alvo não foi fornecido.");
    }
    try {
        const adminUserDoc = await db.collection("users").doc(adminUid).get();
        if (adminUserDoc.data()?.role !== 'admin') {
            throw new HttpsError("permission-denied", "Permissão negada.");
        }
        const targetUserRef = db.collection("users").doc(targetUserId);
        await targetUserRef.update({ isLifetime: true });
        console.log(`Acesso vitalício concedido para ${targetUserId} por ${adminUid}.`);
        return { success: true, message: "Acesso vitalício concedido com sucesso!" };
    } catch (error) {
        console.error("Erro ao conceder acesso vitalício:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Erro interno.");
    }
});


// --- FUNÇÃO 7: Revogar Acesso Vitalício (Ação de Admin) ---
exports.revokeLifetimeAccess = onCall({
    region: "southamerica-east1",
}, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Ação não autorizada.");
    }
    const adminUid = request.auth.uid;
    const targetUserId = request.data.targetUserId;
    if (!targetUserId) {
         throw new HttpsError("invalid-argument", "O ID do usuário alvo não foi fornecido.");
    }
    try {
        const adminUserDoc = await db.collection("users").doc(adminUid).get();
        if (adminUserDoc.data()?.role !== 'admin') {
            throw new HttpsError("permission-denied", "Permissão negada.");
        }
        const targetUserRef = db.collection("users").doc(targetUserId);
        await targetUserRef.update({
            isLifetime: admin.firestore.FieldValue.delete()
        });
        console.log(`Acesso vitalício revogado para ${targetUserId} por ${adminUid}.`);
        return { success: true, message: "Acesso vitalício revogado com sucesso!" };
    } catch (error) {
        console.error("Erro ao revogar acesso vitalício:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Erro interno.");
    }
});

// --- FUNÇÃO 8: Obter Métricas da Plataforma (Ação de Admin) ---
exports.getPlatformMetrics = onCall({
    region: "southamerica-east1",
}, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Ação não autorizada.");
    }
    const adminUid = request.auth.uid;
    try {
        const adminUserDoc = await db.collection("users").doc(adminUid).get();
        if (adminUserDoc.data()?.role !== 'admin') {
            throw new HttpsError("permission-denied", "Permissão negada.");
        }
        const usersSnapshot = await db.collection("users").get();
        let totalUsers = 0;
        let activeSubscribers = 0;
        let lifetimeUsers = 0;
        let trialUsers = 0;
        const fourteenDaysAgo = new Date();
        fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

        usersSnapshot.forEach(doc => {
            totalUsers++;
            const user = doc.data();
            if (user.isLifetime) {
                lifetimeUsers++;
            } else if (user.subscription?.status === 'active') {
                activeSubscribers++;
            } else if (user.createdAt && user.createdAt.toDate() > fourteenDaysAgo) {
                trialUsers++;
            }
        });
        return { totalUsers, activeSubscribers, lifetimeUsers, trialUsers };
    } catch (error) {
        console.error("Erro ao buscar métricas:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Erro ao buscar métricas.");
    }
});

// --- FUNÇÃO 9: Obter Usuários por Filtro (Ação de Admin) ---
exports.getUsersByFilter = onCall({
    region: "southamerica-east1",
}, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Ação não autorizada.");
    }
    const adminUid = request.auth.uid;
    const { filterType } = request.data;

    try {
        const adminUserDoc = await db.collection("users").doc(adminUid).get();
        if (adminUserDoc.data()?.role !== 'admin') {
            throw new HttpsError("permission-denied", "Permissão negada.");
        }

        const allUsersSnapshot = await db.collection("users").get();
        const allUsers = allUsersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const now = new Date();
        const fourteenDays = 14 * 24 * 60 * 60 * 1000;

        let filteredUsers;

        switch (filterType) {
            case 'active':
                filteredUsers = allUsers.filter(u => u.subscription?.status === 'active');
                break;
            case 'lifetime':
                filteredUsers = allUsers.filter(u => u.isLifetime === true);
                break;
            case 'trial':
                filteredUsers = allUsers.filter(u => {
                    const createdAt = u.createdAt?.toDate();
                    if (!u.isLifetime && u.subscription?.status !== 'active' && createdAt) {
                        const trialEndDate = new Date(createdAt.getTime() + fourteenDays);
                        return trialEndDate > now;
                    }
                    return false;
                });
                break;
            case 'expired':
                 filteredUsers = allUsers.filter(u => {
                    const createdAt = u.createdAt?.toDate();
                    if (!u.isLifetime && u.subscription?.status !== 'active' && createdAt) {
                        const trialEndDate = new Date(createdAt.getTime() + fourteenDays);
                        return trialEndDate <= now;
                    }
                    return false;
                });
                break;
            case 'all':
            default:
                filteredUsers = allUsers;
                break;
        }
        
        const usersWithTrialInfo = filteredUsers.map(user => {
            const createdAt = user.createdAt?.toDate();
            if (!user.isLifetime && user.subscription?.status !== 'active' && createdAt) {
                const trialEndDate = new Date(createdAt.getTime() + fourteenDays);
                const daysLeft = Math.ceil((trialEndDate - now) / (1000 * 60 * 60 * 24));
                return { ...user, trialDaysLeft: daysLeft };
            }
            return user;
        });

        return { users: usersWithTrialInfo };

    } catch (error) {
        console.error(`Erro ao buscar usuários com filtro '${filterType}':`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Erro ao buscar usuários.");
    }
});


// --- FUNÇÃO 10: Deletar um Usuário (Ação de Admin) ---
exports.deleteUser = onCall({
    region: "southamerica-east1",
}, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Ação não autorizada. Você precisa estar logado.");
    }
    const adminUid = request.auth.uid;
    const { targetUserId } = request.data;

    if (!targetUserId) {
         throw new HttpsError("invalid-argument", "O ID do usuário alvo não foi fornecido.");
    }

    if (adminUid === targetUserId) {
        throw new HttpsError("permission-denied", "Ação proibida. Você não pode deletar sua própria conta de administrador.");
    }

    try {
        const adminUserDoc = await db.collection("users").doc(adminUid).get();
        if (adminUserDoc.data()?.role !== 'admin') {
            throw new HttpsError("permission-denied", "Permissão negada. Apenas administradores podem deletar usuários.");
        }

        await admin.auth().deleteUser(targetUserId);
        console.log(`Usuário ${targetUserId} deletado do Authentication pelo admin ${adminUid}.`);

        await db.collection("users").doc(targetUserId).delete();
        console.log(`Documento do usuário ${targetUserId} deletado do Firestore pelo admin ${adminUid}.`);
        
        return { success: true, message: "Usuário deletado permanentemente com sucesso!" };

    } catch (error) {
        console.error(`Falha ao deletar usuário ${targetUserId} pelo admin ${adminUid}:`, error);
        if (error instanceof HttpsError) {
            throw error;
        }
        if (error.code === 'auth/user-not-found') {
             throw new HttpsError("not-found", "O usuário a ser deletado não foi encontrado no sistema de autenticação.");
        }
        throw new HttpsError("internal", "Ocorreu um erro interno ao tentar deletar o usuário.");
    }
});