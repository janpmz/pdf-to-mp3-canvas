// Kokoro v1.0 voice catalog (hexgrad/Kokoro-82M VOICES.md).
// Voice names encode their language and gender: af_heart = lang 'a' + female,
// em_alex = lang 'e' + male. default_voice is the best-graded voice per language.

const LANGUAGES = {
    d: { tag: 'de', name: 'German', default_voice: 'dm_martin' },
    a: { tag: 'en-US', name: 'American English', default_voice: 'af_heart' },
    b: { tag: 'en-GB', name: 'British English', default_voice: 'bf_emma' },
    e: { tag: 'es', name: 'Spanish', default_voice: 'ef_dora' },
    f: { tag: 'fr-FR', name: 'French', default_voice: 'ff_siwis' },
    h: { tag: 'hi', name: 'Hindi', default_voice: 'hf_alpha' },
    i: { tag: 'it', name: 'Italian', default_voice: 'if_sara' },
    j: { tag: 'ja', name: 'Japanese', default_voice: 'jf_alpha' },
    p: { tag: 'pt-BR', name: 'Brazilian Portuguese', default_voice: 'pf_dora' },
    z: { tag: 'zh', name: 'Mandarin Chinese', default_voice: 'zf_xiaobei' },
}

const VOICES = {
    d: ['dm_martin'],
    a: [
        'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore',
        'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
        'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael',
        'am_onyx', 'am_puck', 'am_santa',
    ],
    b: [
        'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
        'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
    ],
    e: ['ef_dora', 'em_alex', 'em_santa'],
    f: ['ff_siwis'],
    h: ['hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi'],
    i: ['if_sara', 'im_nicola'],
    j: ['jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo'],
    p: ['pf_dora', 'pm_alex', 'pm_santa'],
    z: [
        'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi',
        'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang',
    ],
}

// Callers may send the kokoro letter ('e') or a common language tag ('es').
const ALIASES = {
    'de': 'd', 'de-de': 'd',
    'en': 'a', 'en-us': 'a', 'en-gb': 'b',
    'es': 'e', 'fr': 'f', 'fr-fr': 'f', 'hi': 'h', 'it': 'i',
    'ja': 'j', 'pt': 'p', 'pt-br': 'p', 'zh': 'z', 'zh-cn': 'z',
}

const ALL_VOICES = new Set(Object.values(VOICES).flat())

function badRequest(message) {
    const error = new Error(message)
    error.status = 400
    return error
}

// Fill in whichever of { voice, lang } is missing and validate they agree.
// voice wins over the default; an explicit lang must match the voice prefix.
function resolveVoiceAndLang({ voice, lang }) {
    if (lang) {
        lang = ALIASES[String(lang).toLowerCase()] || String(lang).toLowerCase()
        if (!LANGUAGES[lang]) {
            throw badRequest(`Unsupported lang '${lang}'. Supported: ${Object.keys(LANGUAGES).join(', ')} (see /voices)`)
        }
    }
    if (voice && !ALL_VOICES.has(voice)) {
        throw badRequest(`Unknown voice '${voice}' (see /voices)`)
    }
    if (voice && lang && voice[0] !== lang) {
        throw badRequest(`Voice '${voice}' is ${LANGUAGES[voice[0]].name}, but lang '${lang}' was requested`)
    }
    if (!lang) lang = voice ? voice[0] : 'a'
    if (!voice) voice = LANGUAGES[lang].default_voice
    return { voice, lang }
}

function getCatalog() {
    return {
        languages: Object.entries(LANGUAGES).map(([lang, info]) => ({
            lang,
            tag: info.tag,
            name: info.name,
            default_voice: info.default_voice,
            voices: VOICES[lang],
        })),
    }
}

module.exports = {
    resolveVoiceAndLang,
    getCatalog,
}
