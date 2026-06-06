import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

// ─── SERVIDOR HTTP ────────────────────────────────────────────────────────────
// Express es el framework que maneja las peticiones HTTP normales.
const app = express();

// cors() permite que el navegador (que corre en otro puerto/dominio) hable con
// este servidor sin que el navegador lo bloquee por seguridad.
app.use(cors());

// Socket.IO necesita un servidor HTTP por debajo. Lo creamos a partir de Express.
const server = http.createServer(app);

// ─── SERVIDOR SOCKET.IO ───────────────────────────────────────────────────────
// Socket.IO se "engancha" al servidor HTTP y añade soporte para WebSockets.
// WebSocket es un canal de comunicación bidireccional y en tiempo real entre
// cliente y servidor (al revés que HTTP, donde solo el cliente puede iniciar).
const io = new Server(server, {
    cors: { origin: "*" }
});

app.get("/", (req, res) => {
    res.send("Servidor funcionando")
});

// ─── SALA DE USUARIOS ─────────────────────────────────────────────────────────
// Guardamos los IDs de todos los sockets conectados en este momento.
// Un Set es como un array pero sin duplicados.
const connectedUsers = new Set();

// ─── EVENTOS DE CONEXIÓN ──────────────────────────────────────────────────────
// Este callback se ejecuta cada vez que un nuevo cliente se conecta.
// Cada cliente recibe un "socket" único, que es su canal de comunicación.
io.on("connection", (socket) => {

    // 1. Le decimos al recién llegado quiénes ya estaban en la sala,
    //    para que ÉL sea quien inicie la conexión WebRTC con cada uno.
    //    (Array.from convierte el Set en array, que sí se puede enviar como JSON)
    socket.emit("existing-users", Array.from(connectedUsers));

    // 2. Avisamos a todos los demás que llegó alguien nuevo.
    //    broadcast.emit = "envía a todos MENOS a quien acaba de conectarse".
    socket.broadcast.emit("user-connected", socket.id);

    // 3. Añadimos al nuevo a la lista de conectados.
    connectedUsers.add(socket.id);

    // ─── SEÑALIZACIÓN WEBRTC ─────────────────────────────────────────────────
    // Los siguientes eventos son el "teléfono" que usan los clientes para
    // negociar cómo conectarse entre sí. El servidor solo reenvía los mensajes,
    // no entiende su contenido (eso es cosa de los navegadores).

    // Oferta: el nuevo usuario le propone una conexión a alguien ya conectado.
    // data.to = ID del destinatario. Añadimos data.from para que el receptor
    // sepa quién le mandó la oferta y pueda responderle.
    socket.on("offer", (data) => {
        io.to(data.to).emit("offer", { ...data, from: socket.id });
    })

    // Respuesta: el receptor acepta la oferta y responde con su propia descripción.
    socket.on("answer", (data) => {
        io.to(data.to).emit("answer", data);
    })

    // ICE candidates: son las "rutas de red" posibles para llegar al otro
    // (IP pública, IP local, relay TURN...). Se intercambian mientras la
    // conexión P2P se está negociando.
    socket.on("ice-candidate", (data) => {
        io.to(data.to).emit("ice-candidate", data);
    })

    // Desconexión: limpiamos la lista y avisamos a los demás.
    socket.on("disconnect", () => {
        console.log(`Usuario desconectado ${socket.id}`);
        connectedUsers.delete(socket.id);
        socket.broadcast.emit("user-disconnected", socket.id);
    })
})

server.listen(3000, () => {
    console.log("Servidor corriendo en el puerto 3000")
})
