'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { generateWAMessageFromContent, prepareWAMessageMedia, proto } = require('@whiskeysockets/baileys');

const run = promisify(execFile);
const pendingAudio = new WeakMap();
let encoderInstalled = false;

function installEncoder() {
  if (encoderInstalled) return;
  const sticker = proto.Message.StickerMessage;
  const encode = sticker.encode;
  sticker.encode = (message, writer) => {
    const result = encode(message, writer);
    const audio = pendingAudio.get(message);
    // StickerMessage field 26 carries the encrypted audio attachment.
    if (audio) proto.Message.AudioMessage.encode(audio, result.uint32(210).fork()).ldelim();
    return result;
  };
  encoderInstalled = true;
}

function encodeClip(input, output, args) {
  return run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-threads', '2', '-i', input,
    '-t', '5', ...args, output], { timeout: 25000, killSignal: 'SIGKILL' });
}

function createSoundSticker({ quotedMedia, getBuffer }, pilotNumber) {
  return {
    name: 'soundsticker',
    category: 'Media tools',
    description: 'Make an animated sticker with the original video sound',
    usage: '.soundsticker (reply to a video in Message yourself)',
    ownerOnly: true,
    async execute(ctx) {
      if (!ctx.message.key.fromMe || ctx.isGroup || ctx.senderNumber !== pilotNumber ||
          ![ctx.sender, ctx.botJid, ctx.botLid, pilotNumber + '@s.whatsapp.net'].includes(ctx.jid)) {
        return { ok: false, message: 'The sound sticker pilot is available in Message yourself on the test account.' };
      }

      if (ctx.db.get('soundsticker.busy', false) > Date.now()) {
        return { ok: false, message: 'Wait for the current sound sticker to finish.' };
      }
      ctx.db.set('soundsticker.busy', Date.now() + 120000);
      let dir;
      try {
        const media = quotedMedia(ctx);
        if (media?.type !== 'video') return { ok: false, message: 'Reply to a regular video with sound using .soundsticker.' };
        await mkdir(ctx.config.tempDir, { recursive: true, mode: 0o700 });
        dir = await mkdtemp(join(ctx.config.tempDir, 'soundsticker-'));
        const input = join(dir, 'clip.mp4');
        const stickerFile = join(dir, 'clip.webp');
        const audioFile = join(dir, 'clip.ogg');
        await writeFile(input, await getBuffer(media, ctx.config.maxMediaBytes), { mode: 0o600 });
        try {
          await encodeClip(input, audioFile, ['-map', '0:a:0', '-vn', '-c:a', 'libopus', '-ac', '1', '-b:a', '32k']);
        } catch (error) {
          if (error.stderr?.includes('matches no streams')) return { ok: false, message: 'That video has no audio track.' };
          throw error;
        }
        const filter = 'fps=10,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2';
        await encodeClip(input, stickerFile, ['-an', '-vf', filter, '-c:v', 'libwebp', '-loop', '0', '-q:v', '55']);
        const options = { upload: ctx.sock.waUploadToServer, mediaUploadTimeoutMs: 20000 };
        const { stickerMessage } = await prepareWAMessageMedia({
          sticker: await readFile(stickerFile), width: 512, height: 512, isAnimated: true,
        }, options);
        const { audioMessage } = await prepareWAMessageMedia({
          audio: await readFile(audioFile), mimetype: 'audio/ogg; codecs=opus',
        }, options);
        installEncoder();
        const outgoing = generateWAMessageFromContent(ctx.jid, { stickerMessage }, {
          userJid: ctx.sock.user.id, quoted: ctx.message,
        });
        pendingAudio.set(outgoing.message.stickerMessage, audioMessage);
        await ctx.sock.relayMessage(ctx.jid, outgoing.message, { messageId: outgoing.key.id });
        return { ok: true, sent: true };
      } catch (error) {
        ctx.logger?.warn?.({ code: error.code }, 'Sound sticker conversion or delivery failed');
        return { ok: false, message: 'I couldn’t send a sound sticker from that clip. Try a short video with sound.' };
      } finally {
        ctx.db.set('soundsticker.busy', 0);
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

module.exports = { createSoundSticker };
