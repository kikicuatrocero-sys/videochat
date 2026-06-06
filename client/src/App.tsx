import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

// ─── SOCKET (SEÑALIZACIÓN) ────────────────────────────────────────────────────
// Creamos la conexión con el servidor Socket.IO.
// - Sin URL explícita: se conecta al mismo origen que la página
//   (localhost:5173 en dev, la URL de ngrok en producción).
// - autoConnect: false → no se conecta solo al cargar, esperamos a que el
//   usuario pulse un botón.
// - extraHeaders: evita la página de advertencia de ngrok en peticiones XHR.
//
// Este socket vive FUERA del componente para que React no lo recree en cada
// render. Es una conexión global y única durante toda la sesión.
const socket = io({
  autoConnect: false,
  extraHeaders: { 'ngrok-skip-browser-warning': 'true' },
})

function App() {

  // ─── ESTADO ─────────────────────────────────────────────────────────────────
  // localStream: el stream de tu propia pantalla (video + audio).
  //   null = aún no has compartido nada.
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  // joined: ¿ya te has unido a la sala?
  //   false = pantalla de inicio con botones, true = conectado.
  const [joined, setJoined] = useState(false);

  // ─── REFS ────────────────────────────────────────────────────────────────────
  // Los refs apuntan directamente a elementos del DOM o a valores que NO deben
  // provocar un re-render cuando cambian.

  // Elemento <video> donde se muestra tu propia pantalla (silenciado).
  const localVideoRef = useRef<HTMLVideoElement>(null);

  // Elemento <video> donde se muestra la pantalla del otro usuario.
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  // La conexión WebRTC activa. La guardamos en un ref (no en state) porque
  // necesitamos leerla dentro de callbacks sin que su cambio cause re-renders.
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);

  // Espejo en ref del estado localStream. Los handlers del socket se definen
  // una sola vez (dentro del useEffect) y capturan el valor inicial de
  // localStream. Este ref siempre tiene el valor más reciente sin necesitar
  // re-definir los handlers.
  const localStreamRef = useRef<MediaStream | null>(null);
  localStreamRef.current = localStream; // se actualiza en cada render

  // ─── ACCIONES DEL USUARIO ────────────────────────────────────────────────────

  // Pide permiso para compartir pantalla y opcionalmente el micrófono.
  // withMic = true → combina pantalla + micrófono en un solo stream.
  // withMic = false → solo pantalla (con audio del sistema si el navegador lo soporta).
  const startSharing = async (withMic: boolean) => {
    // getDisplayMedia abre el diálogo nativo del navegador para elegir qué compartir.
    // Desactivamos el procesado de voz (echo cancellation, noise suppression, etc.)
    // porque el audio del sistema no es una llamada de voz y ese procesado lo degrada.
    // Pedimos estéreo y 48kHz para máxima calidad.
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 2,
      },
    });

    let finalStream = screenStream;

    if (withMic) {
      // Para el micrófono sí mantenemos echo cancellation y noise suppression
      // porque aquí sí es audio de voz en tiempo real.
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 1,
        },
        video: false,
      });
      // Combinamos las pistas de pantalla + las pistas de audio del micro
      // en un nuevo MediaStream unificado.
      finalStream = new MediaStream([
        ...screenStream.getTracks(),
        ...micStream.getAudioTracks(),
      ]);
    }

    setLocalStream(finalStream);

    // Asignamos el stream al elemento <video> local para que te veas a ti mismo.
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = finalStream;
    }

    // Marcamos que el usuario ya entró a la sala, lo que activa el useEffect.
    setJoined(true);
  };

  // Entrar a la sala sin compartir nada (solo para ver).
  const handleJoinOnly = () => {
    setJoined(true);
  };

  // ─── LÓGICA WEBRTC + SOCKET ───────────────────────────────────────────────────
  // Este useEffect se ejecuta cuando joined cambia de false a true.
  // Aquí vivé toda la lógica de señalización y WebRTC.
  useEffect(() => {
    if (!joined) return;

    // Buffer de ICE candidates que llegan antes de que tengamos remoteDescription.
    // Esto puede pasar porque la red es rápida y los candidates llegan antes
    // de que procesemos la oferta/respuesta del otro.
    const pendingCandidates: RTCIceCandidateInit[] = [];

    // Sube el bitrate de audio a 128 kbps en todos los senders de audio de la conexión.
    // WebRTC usa Opus por defecto a ~32 kbps (suficiente para voz, malo para música/sistema).
    // Con 128 kbps la calidad es claramente superior.
    const setHighQualityAudio = async (pc: RTCPeerConnection) => {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'audio') continue;
        const params = sender.getParameters();
        if (params.encodings.length === 0) params.encodings = [{}];
        params.encodings[0].maxBitrate = 128_000; // 128 kbps
        await sender.setParameters(params);
      }
    };

    // Procesa todos los candidates guardados en el buffer.
    const addPendingCandidates = async (pc: RTCPeerConnection) => {
      for (const candidate of pendingCandidates) {
        await pc.addIceCandidate(candidate);
      }
      pendingCandidates.length = 0; // vacía el buffer
    };

    // ── createPeerConnection ───────────────────────────────────────────────────
    // Crea y configura una RTCPeerConnection, que es el canal P2P real entre
    // los dos navegadores. Toda la lógica de WebRTC vive aquí.
    const createPeerConnection = () => {
      const pc = new RTCPeerConnection({
        // Los iceServers son servidores externos que ayudan a los dos navegadores
        // a descubrir cómo llegar el uno al otro a través de firewalls y NAT.
        //
        // STUN: le dice a tu navegador "tu IP pública es X.X.X.X".
        // TURN: actúa como relay cuando la conexión directa es imposible
        //       (redes con NAT simétrico, como algunas redes móviles).
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          {
            urls: "turn:openrelay.metered.ca:80",
            username: "openrelayproject",
            credential: "openrelayproject",
          },
          {
            urls: "turn:openrelay.metered.ca:443",
            username: "openrelayproject",
            credential: "openrelayproject",
          },
        ],
      });

      // Guardamos la referencia para usarla en los handlers de answer e ice-candidate.
      peerConnectionRef.current = pc;

      const stream = localStreamRef.current;
      if (stream) {
        // Si tenemos stream propio, añadimos todas sus pistas (video + audio)
        // a la conexión para enviárselas al otro.
        stream.getTracks().forEach(track => pc.addTrack(track, stream));
      } else {
        // Si somos "solo ver", declaramos que queremos recibir video y audio
        // pero no vamos a enviar nada.
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
      }

      // ontrack se dispara cuando empiezan a llegar las pistas del otro usuario.
      // event.streams[0] es el stream remoto completo (video + audio).
      pc.ontrack = (event) => {
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0];
        }
      };

      return pc;
    };

    // ── createOffer ────────────────────────────────────────────────────────────
    // El nuevo usuario (nosotros) inicia la negociación con alguien que ya estaba.
    // Una "offer" es básicamente: "hola, aquí están mis capacidades de video/audio,
    // ¿cómo nos conectamos?". Está codificada en formato SDP (Session Description Protocol).
    const createOffer = async (remoteUserId: string) => {
      const pc = createPeerConnection();

      // onicecandidate se dispara mientras el navegador descubre rutas de red.
      // Cada candidate es una dirección IP + puerto por donde podría llegar el otro.
      // Los enviamos al servidor para que los reenvíe al otro usuario.
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("ice-candidate", { to: remoteUserId, candidate: event.candidate });
        }
      };

      const offer = await pc.createOffer();
      // setLocalDescription registra la oferta en nuestra propia conexión
      // y activa el proceso de descubrimiento de ICE candidates.
      await pc.setLocalDescription(offer);
      await setHighQualityAudio(pc);
      socket.emit("offer", { to: remoteUserId, offer });
    };

    // ─── CONECTAR AL SERVIDOR ─────────────────────────────────────────────────
    socket.connect();

    // ─── EVENTOS DEL SERVIDOR ─────────────────────────────────────────────────

    // El servidor nos envía la lista de usuarios que ya estaban en la sala.
    // Como somos los recién llegados, somos nosotros quienes iniciamos la oferta
    // con cada uno de ellos.
    socket.on("existing-users", async (existingUsers: string[]) => {
      for (const userId of existingUsers) {
        await createOffer(userId);
      }
    });

    // Alguien llegó después que nosotros. Ellos nos mandarán su oferta,
    // así que aquí solo registramos el evento (sin hacer nada todavía).
    socket.on("user-connected", (newUserId) => {
      console.log("Nuevo usuario conectado:", newUserId);
    });

    // Recibimos una oferta de alguien que llegó después que nosotros.
    // Respondemos con un "answer": "OK, acepto tus condiciones, aquí las mías".
    socket.on("offer", async (data) => {
      const remoteUserId = data.from;
      const pc = createPeerConnection();

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("ice-candidate", { to: remoteUserId, candidate: event.candidate });
        }
      };

      // Registramos la descripción del otro (su oferta) como "remoteDescription".
      await pc.setRemoteDescription(data.offer);
      // Procesamos los ICE candidates que pudieron haber llegado antes que la oferta.
      await addPendingCandidates(pc);
      // Creamos nuestra respuesta y la registramos como "localDescription".
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await setHighQualityAudio(pc);
      socket.emit("answer", { to: remoteUserId, answer });
    });

    // Recibimos la respuesta a nuestra oferta.
    // Con esto ya tenemos la descripción completa de ambos lados y la conexión
    // P2P puede establecerse.
    socket.on("answer", async (data) => {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(data.answer);
        await addPendingCandidates(peerConnectionRef.current);
      }
    });

    // Recibimos un ICE candidate del otro usuario.
    // Si ya tenemos remoteDescription lo procesamos de inmediato;
    // si no, lo guardamos en el buffer para procesarlo después.
    socket.on("ice-candidate", async (data) => {
      const pc = peerConnectionRef.current;
      if (pc && pc.remoteDescription) {
        await pc.addIceCandidate(data.candidate);
      } else {
        pendingCandidates.push(data.candidate);
      }
    });

    // ─── CLEANUP ──────────────────────────────────────────────────────────────
    // React ejecuta esta función cuando el componente se desmonta o antes de
    // re-ejecutar el effect. Limpiamos los listeners para no acumularlos.
    return () => {
      socket.off("existing-users");
      socket.off("user-connected");
      socket.off("offer");
      socket.off("answer");
      socket.off("ice-candidate");
      socket.disconnect();
    };
  }, [joined]); // solo se ejecuta cuando joined cambia

  // ─── RENDER ───────────────────────────────────────────────────────────────────
  return (
    <div>
      <h1>Videochat</h1>

      {/* Pantalla de inicio: se oculta en cuanto el usuario pulsa cualquier botón */}
      {!joined && (
        <div>
          {/* Comparte pantalla intentando capturar el audio del sistema */}
          <button onClick={() => startSharing(false)}>Compartir pantalla (audio del sistema)</button>
          {/* Comparte pantalla y añade el micrófono explícitamente (necesario en Firefox) */}
          <button onClick={() => startSharing(true)}>Compartir pantalla + micrófono</button>
          {/* Entrar sin compartir, solo para ver (útil en móvil) */}
          <button onClick={handleJoinOnly}>Solo ver</button>
        </div>
      )}

      {/* Tu propia pantalla compartida. muted para no escucharte a ti mismo.
          playsInline evita que iOS lo ponga en fullscreen automáticamente. */}
      <video ref={localVideoRef} autoPlay muted playsInline />

      {/* La pantalla del otro usuario. controls muestra los controles nativos
          del navegador, incluyendo el botón de pantalla completa. */}
      <video ref={remoteVideoRef} autoPlay playsInline controls />
    </div>
  );
}

export default App;
