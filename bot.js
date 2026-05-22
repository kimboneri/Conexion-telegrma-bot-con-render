const { Telegraf, session } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const http = require('http');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (!supabaseUrl || !supabaseKey) {
    console.error("Error: Configura SUPABASE_URL y SUPABASE_KEY en .env");
    process.exit(1);
}
if (!botToken) {
    console.error("Error: Configura TELEGRAM_BOT_TOKEN en .env");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const STORAGE_BUCKET = 'sneakers';
console.log("Cliente de Supabase inicializado.");

const CONFIG = {
  ACTIVO_DESDE: 8,
  ACTIVO_HASTA: 24,
  ZONA_HORARIA: 'America/Lima',
  DURACION_EMERGENCIA: 120,
};
const INTERVALO_PING = 10 * 60 * 1000;
const BOT_URL = 'https://telegram-bot-sneakers.onrender.com';
let modo24hHasta = null;

function horaLocal() {
  return parseInt(
    new Intl.DateTimeFormat('es-CO', {
      hour: 'numeric', hour12: false,
      timeZone: CONFIG.ZONA_HORARIA
    }).format(new Date())
  );
}

function estaEnHorario() {
  const hora = horaLocal();
  if (CONFIG.ACTIVO_DESDE < CONFIG.ACTIVO_HASTA) {
    return hora >= CONFIG.ACTIVO_DESDE && hora < CONFIG.ACTIVO_HASTA;
  }
  return hora >= CONFIG.ACTIVO_DESDE || hora < CONFIG.ACTIVO_HASTA;
}

function formatoHorario() {
  const desde = `${CONFIG.ACTIVO_DESDE}:00`;
  const hasta = CONFIG.ACTIVO_HASTA === 24 ? '12:00 AM' : `${CONFIG.ACTIVO_HASTA}:00`;
  return `${desde} a ${hasta} (hora ${CONFIG.ZONA_HORARIA})`;
}

function enModoEmergencia() {
  return modo24hHasta !== null && Date.now() < modo24hHasta;
}

function tiempoRestanteEmergencia() {
  if (!enModoEmergencia()) return 0;
  return Math.round((modo24hHasta - Date.now()) / 60000);
}

function mensajeEmergencia() {
  if (!enModoEmergencia()) return '';
  const mins = tiempoRestanteEmergencia();
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `\n\n⚡ *Modo emergencia activo* — quedan ${h > 0 ? `${h}h ` : ''}${m}min`;
}

const MENU = `🤖 *Bot Sneakers — Menú*

1️⃣ *Registrar venta* — Modelo, talla y precio
2️⃣ *Nota rápida* — Anotación sin estructura
3️⃣ *Últimos registros* — Ver últimos 5
4️⃣ *Ayuda* — Cómo usar el bot

Responde con el *número* de la opción.`;

const bot = new Telegraf(botToken);

bot.use(session());
bot.use((ctx, next) => {
    if (!ctx.session) ctx.session = {};
    if (!ctx.session.estado) ctx.session.estado = 'IDLE';
    if (!ctx.session.datos) ctx.session.datos = {};
    return next();
});

bot.use((ctx, next) => {
  if (enModoEmergencia() || estaEnHorario()) {
    return next();
  }
  const texto = ctx.message?.text || '';
  if (texto === '/24h' || texto === '/cancelar24h') {
    return next();
  }
  const horaApertura = `${CONFIG.ACTIVO_DESDE}:00`;
  return ctx.reply(
    `😴 *Bot fuera de horario*

Actualmente estoy descansando 🛌
Volveré a atenderte a las *${horaApertura}*.

⏰ *Horario:* ${formatoHorario()}`,
    { parse_mode: 'Markdown' }
  );
});

async function guardarEnSupabase(remitente, contenido, imagenUrl = null) {
    const payload = { remitente: `telegram:${remitente}`, contenido };
    if (imagenUrl) payload.imagen_url = imagenUrl;
    const { error } = await supabase
        .from('mensajes_wsp')
        .insert([payload]);
    return !error;
}

async function obtenerUltimosRegistros(limite = 5) {
    const { data, error } = await supabase
        .from('mensajes_wsp')
        .select('contenido, fecha, imagen_url')
        .order('fecha', { ascending: false })
        .limit(limite);
    return error ? null : data;
}

function formatearFecha(iso) {
    const d = new Date(iso);
    return d.toLocaleString('es-ES', {
        day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit'
    });
}

// Inicio
bot.start((ctx) => {
    ctx.session.estado = 'IDLE';
    ctx.session.datos = {};
    ctx.reply(`👋 ¡Bienvenido al *Bot Sneakers*!

⏰ *Horario:* ${formatoHorario()}

` + MENU, { parse_mode: 'Markdown' });
});

bot.help((ctx) => {
    ctx.reply(`🤖 *Bot Sneakers — Ayuda*

• *Registrar venta:* Te guío paso a paso (modelo → talla → precio)
• *Nota rápida:* Guarda cualquier texto o foto
• *Últimos registros:* Muestra los últimos 5 con fotos si tienen

Comandos:
/menu — Muestra el menú principal
/cancelar — Cancela la operación actual

⏰ *Horario:* ${formatoHorario()}`, { parse_mode: 'Markdown' });
});

bot.command('menu', (ctx) => {
    ctx.session.estado = 'IDLE';
    ctx.session.datos = {};
    ctx.reply(MENU, { parse_mode: 'Markdown' });
});

bot.command('cancelar', (ctx) => {
    if (ctx.session.estado !== 'IDLE') {
        ctx.session.estado = 'IDLE';
        ctx.session.datos = {};
        ctx.reply(`❌ Operación cancelada.\n\n${MENU}`, { parse_mode: 'Markdown' });
    } else {
        ctx.reply('No hay ninguna operación activa.');
    }
});

bot.command('24h', (ctx) => {
  if (enModoEmergencia()) {
    const mins = tiempoRestanteEmergencia();
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return ctx.reply(
      `⚡ *Modo emergencia ya activo*\n\nQuedan ${h > 0 ? `${h}h ` : ''}${m}min restantes.\n\nPara desactivarlo, usá /cancelar24h`,
      { parse_mode: 'Markdown' }
    );
  }
  modo24hHasta = Date.now() + CONFIG.DURACION_EMERGENCIA * 60 * 1000;
  ctx.reply(
    `🚨 *Modo emergencia activado*\n\nEl bot estará disponible por *${CONFIG.DURACION_EMERGENCIA} minutos* sin límite de horario.\n\nPara desactivarlo antes, usá /cancelar24h`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('cancelar24h', (ctx) => {
  if (!enModoEmergencia()) {
    return ctx.reply('El modo emergencia no está activo.', { parse_mode: 'Markdown' });
  }
  modo24hHasta = null;
  ctx.reply(
    `✅ *Modo emergencia desactivado*\n\nEl bot vuelve a su horario normal: ${formatoHorario()}`,
    { parse_mode: 'Markdown' }
  );
});

// Manejar fotos
bot.on('photo', async (ctx) => {
    const usuarioId = ctx.from.id.toString();
    const caption = ctx.message.caption || '';

    try {
        const fotos = ctx.message.photo;
        const mejorFoto = fotos[fotos.length - 1];

        await ctx.reply(`📸 Recibí tu foto, subiéndola...`);

        const link = await ctx.telegram.getFileLink(mejorFoto.file_id);
        const resp = await fetch(link.href);
        const buffer = Buffer.from(await resp.arrayBuffer());

        const ext = link.href.endsWith('.png') ? 'png' : 'jpg';
        const filename = `${crypto.randomUUID()}.${ext}`;

        const { error: uploadError } = await supabase.storage
            .from(STORAGE_BUCKET)
            .upload(filename, buffer, {
                contentType: ext === 'png' ? 'image/png' : 'image/jpeg',
                upsert: false
            });

        if (uploadError) {
            await ctx.reply(`❌ Error al subir la imagen: ${uploadError.message}`);
            return;
        }

        const { data: { publicUrl } } = supabase.storage
            .from(STORAGE_BUCKET)
            .getPublicUrl(filename);

        const textoFinal = caption
            ? `📷 Foto con nota: ${caption}`
            : '📷 Foto recibida';

        const ok = await guardarEnSupabase(usuarioId, textoFinal, publicUrl);

        if (ok) {
            await ctx.replyWithPhoto(publicUrl, {
                caption: `✅ Foto guardada${caption ? ` con nota: "${caption}"` : ''}.\n\n${MENU}`
            });
        } else {
            await ctx.reply(`❌ Error al guardar en BD.\n\n${MENU}`, { parse_mode: 'Markdown' });
        }
    } catch (err) {
        console.error(`[Error foto] ${err}`);
        await ctx.reply('❌ Error al procesar la foto.');
    }
});

// Manejador de texto
bot.on('text', async (ctx) => {
    const texto = ctx.message.text.trim();
    const usuarioId = ctx.from.id.toString();

    try {
        switch (ctx.session.estado) {

            case 'IDLE': {
                if (texto === '1') {
                    ctx.session.estado = 'AWAITING_VENTA_MODEL';
                    ctx.session.datos = {};
                    await ctx.reply(`✅ *Registrar venta*

¿Cuál es el *modelo* del sneaker? (ej: Jordan 1 Chicago)`, { parse_mode: 'Markdown' });
                } else if (texto === '2') {
                    ctx.session.estado = 'AWAITING_NOTA_CONTENIDO';
                    ctx.session.datos = {};
                    await ctx.reply(`📋 *Nota rápida*

Escribe la nota que quieras guardar:`, { parse_mode: 'Markdown' });
                } else if (texto === '3') {
                    await mostrarUltimosRegistros(ctx);
                } else if (texto === '4') {
                    await ctx.reply(`🤖 *Bot Sneakers — Ayuda*

• *Registrar venta:* Te guío paso a paso (modelo → talla → precio)
• *Nota rápida:* Guarda cualquier texto o foto
• *Últimos registros:* Muestra los últimos 5

Comandos:
/menu — Menú principal
/cancelar — Cancela la operación actual`, { parse_mode: 'Markdown' });
                } else {
                    await guardarEnSupabase(usuarioId, texto);
                    await ctx.reply(`✅ Mensaje guardado.\n\n${MENU}`, { parse_mode: 'Markdown' });
                }
                break;
            }

            case 'AWAITING_VENTA_MODEL': {
                ctx.session.datos.modelo = texto;
                ctx.session.estado = 'AWAITING_VENTA_SIZE';
                await ctx.reply(`Modelo: *${texto}*

¿Cuál es la *talla*? (ej: 9.5)`, { parse_mode: 'Markdown' });
                break;
            }

            case 'AWAITING_VENTA_SIZE': {
                ctx.session.datos.talla = texto;
                ctx.session.estado = 'AWAITING_VENTA_PRICE';
                await ctx.reply(`Modelo: *${ctx.session.datos.modelo}* | Talla: *${texto}*

¿Cuál es el *precio*? (ej: 200)`, { parse_mode: 'Markdown' });
                break;
            }

            case 'AWAITING_VENTA_PRICE': {
                ctx.session.datos.precio = texto;
                const { modelo, talla, precio } = ctx.session.datos;
                const contenidoFinal = `🛒 Venta | Modelo: ${modelo} | Talla: ${talla} | Precio: ${precio}`;

                const ok = await guardarEnSupabase(usuarioId, contenidoFinal);
                ctx.session.estado = 'IDLE';
                ctx.session.datos = {};

                if (ok) {
                    await ctx.reply(`✅ *Venta registrada con éxito*

• Modelo: *${modelo}*
• Talla: *${talla}*
• Precio: *${precio}*

${MENU}`, { parse_mode: 'Markdown' });
                } else {
                    await ctx.reply(`❌ Error al guardar.\n\n${MENU}`, { parse_mode: 'Markdown' });
                }
                break;
            }

            case 'AWAITING_NOTA_CONTENIDO': {
                const contenidoFinal = `📋 Nota: ${texto}`;
                const ok = await guardarEnSupabase(usuarioId, contenidoFinal);
                ctx.session.estado = 'IDLE';
                ctx.session.datos = {};

                if (ok) {
                    await ctx.reply(`✅ *Nota guardada*\n\n${MENU}`, { parse_mode: 'Markdown' });
                } else {
                    await ctx.reply(`❌ Error al guardar.\n\n${MENU}`, { parse_mode: 'Markdown' });
                }
                break;
            }

            default:
                ctx.session.estado = 'IDLE';
                await ctx.reply(MENU, { parse_mode: 'Markdown' });
        }
    } catch (err) {
        console.error(`[Error] ${err}`);
        await ctx.reply('❌ Ocurrió un error. Intenta de nuevo.');
    }
});

async function mostrarUltimosRegistros(ctx) {
    const registros = await obtenerUltimosRegistros();
    if (!registros || registros.length === 0) {
        await ctx.reply(`📭 No hay registros todavía.\n\n${MENU}`, { parse_mode: 'Markdown' });
        return;
    }

    for (const r of registros) {
        let mensaje = `${r.contenido}\n🕐 ${formatearFecha(r.fecha)}`;
        if (r.imagen_url) {
            await ctx.replyWithPhoto(r.imagen_url, { caption: mensaje });
        } else {
            await ctx.reply(mensaje);
        }
    }

    await ctx.reply(MENU, { parse_mode: 'Markdown' });
}

bot.catch((err, ctx) => {
    console.error(`[Error global] ${err}`);
});

const PORT = process.env.PORT || 10000;
const WEBHOOK_PATH = '/telegraf';
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}${WEBHOOK_PATH}`
  : `https://telegram-bot-sneakers.onrender.com${WEBHOOK_PATH}`;

const webhookHandler = bot.webhookCallback(WEBHOOK_PATH);

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === WEBHOOK_PATH) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      req.body = JSON.parse(body);
      webhookHandler(req, res);
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  }
});

async function autoPing() {
  if (!enModoEmergencia() && !estaEnHorario()) return;
  try {
    await fetch(BOT_URL);
    console.log(`[Keepalive] OK - ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error(`[Keepalive] Error: ${err.message}`);
  }
}

server.listen(PORT, async () => {
  console.log(`Servidor HTTP escuchando en puerto ${PORT}`);
  try {
    await bot.telegram.setWebhook(WEBHOOK_URL);
    console.log(`Webhook configurado: ${WEBHOOK_URL}`);
  } catch (err) {
    console.error(`Error al configurar webhook: ${err}`);
  }
  await autoPing();
  setInterval(autoPing, INTERVALO_PING);
  console.log(`Auto-ping cada 10 min activado (${formatoHorario()})`);
});
