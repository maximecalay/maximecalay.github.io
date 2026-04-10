/**
 * LectoDys — Assistant de lecture pour la dyslexie
 * Application PWA : Photo → OCR/IA → Lecture à voix haute
 */

(function () {
    'use strict';

    // ===== STATE =====
    const state = {
        currentImage: null,    // base64 de l'image
        extractedText: '',
        isPlaying: false,
        currentWordIndex: -1,
        selectedWordIndex: -1, // mot sélectionné par clic (surbrillance persistante)
        utterance: null,
        words: [],             // éléments DOM des mots
        audioElement: null,    // for OpenAI TTS playback
        settings: loadSettings()
    };

    // ===== SETTINGS =====
    function defaultSettings() {
        return {
            ocrMethod: 'openai',
            apiKey: '',
            ttsMethod: 'browser',    // 'browser' or 'openai-tts'
            openaiVoice: 'nova',     // nova, alloy, echo, fable, shimmer, onyx
            voiceName: '',
            speed: 0.9,
            fontSize: 24,
            dyslexicFont: true,
            syllables: false,
            lineSpacing: true,
            highlightColor: '#FFE082',
            darkMode: false,
            demoUsed: false          // track if demo scan has been used
        };
    }

    function loadSettings() {
        try {
            const saved = localStorage.getItem('lectodys-settings');
            if (saved) {
                return { ...defaultSettings(), ...JSON.parse(saved) };
            }
        } catch (e) { /* ignore */ }
        return defaultSettings();
    }

    function saveSettings() {
        try {
            localStorage.setItem('lectodys-settings', JSON.stringify(state.settings));
        } catch (e) { /* ignore */ }
    }

    // ===== DOM REFS =====
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const screens = {
        home: $('#screen-home'),
        preview: $('#screen-preview'),
        loading: $('#screen-loading'),
        reader: $('#screen-reader'),
        paste: $('#screen-paste'),
        settings: $('#screen-settings')
    };

    // ===== NAVIGATION =====
    function showScreen(name) {
        Object.values(screens).forEach(s => s.classList.remove('active'));
        screens[name].classList.add('active');
        // Stop TTS when leaving reader
        if (name !== 'reader') {
            stopSpeech();
        }
    }

    // ===== TOAST =====
    let toastTimeout;
    function showToast(message, duration = 2500) {
        let toast = $('.toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'toast';
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.classList.add('show');
        clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => toast.classList.remove('show'), duration);
    }

    // ===== IMAGE HANDLING =====
    function handleImageSelected(file) {
        if (!file || !file.type.startsWith('image/')) {
            showToast('Fichier non reconnu');
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            state.currentImage = e.target.result;
            $('#preview-image').src = state.currentImage;
            showScreen('preview');
        };
        reader.readAsDataURL(file);
    }

    // Image enhancement (contrast boost for poor photocopies)
    function enhanceImage(base64) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const canvas = $('#preview-canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = img.width;
                canvas.height = img.height;
                ctx.drawImage(img, 0, 0);

                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const data = imageData.data;

                // Grayscale + contrast enhancement
                for (let i = 0; i < data.length; i += 4) {
                    // Grayscale
                    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

                    // Contrast stretch
                    const contrast = 1.5;
                    const factor = (259 * (contrast * 128 + 255)) / (255 * (259 - contrast * 128));
                    let val = factor * (gray - 128) + 128;
                    val = Math.max(0, Math.min(255, val));

                    // Sharpen: simple threshold for very poor copies
                    if (val < 140) val = Math.max(0, val - 30);
                    else val = Math.min(255, val + 30);

                    data[i] = data[i + 1] = data[i + 2] = val;
                }

                ctx.putImageData(imageData, 0, 0);
                resolve(canvas.toDataURL('image/jpeg', 0.92));
            };
            img.src = base64;
        });
    }

    // ===== OCR / AI TEXT EXTRACTION =====
    async function extractText(imageBase64) {
        const method = state.settings.ocrMethod;

        if (method === 'openai') {
            return extractWithOpenAI(imageBase64);
        } else {
            return extractWithTesseract(imageBase64);
        }
    }

    async function extractWithOpenAI(imageBase64) {
        const apiKey = state.settings.apiKey;
        if (!apiKey) {
            throw new Error('Clé API OpenAI non configurée. Va dans les Réglages (⚙️).');
        }

        // Remove data URL prefix to get pure base64
        const base64Data = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [
                    {
                        role: 'system',
                        content: `Tu es un assistant qui extrait le texte des documents scolaires photographiés. 
Règles :
- Extrais TOUT le texte visible, fidèlement.
- Corrige les éventuelles erreurs dues à la mauvaise qualité de la photocopie.
- Conserve la mise en forme (paragraphes, listes, numérotation).
- Si du texte est illisible, indique [illisible].
- Ne commente pas, ne résume pas. Donne uniquement le texte extrait.
- Le texte est en français.`
                    },
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: 'Extrais tout le texte de cette image de document scolaire :'
                            },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:image/jpeg;base64,${base64Data}`,
                                    detail: 'high'
                                }
                            }
                        ]
                    }
                ],
                max_tokens: 4096,
                temperature: 0.1
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            if (response.status === 401) {
                throw new Error('Clé API invalide. Vérifie dans les Réglages.');
            }
            throw new Error(err.error?.message || `Erreur API (${response.status})`);
        }

        const data = await response.json();
        return data.choices[0].message.content.trim();
    }

    async function extractWithTesseract(imageBase64) {
        $('#loading-message').textContent = 'Chargement du moteur OCR...';

        const worker = await Tesseract.createWorker('fra', 1, {
            logger: (m) => {
                if (m.status === 'recognizing text') {
                    const pct = Math.round(m.progress * 100);
                    $('#loading-message').textContent = `Analyse en cours... ${pct}%`;
                }
            }
        });

        const result = await worker.recognize(imageBase64);
        await worker.terminate();

        const text = result.data.text.trim();
        if (!text) {
            throw new Error('Aucun texte détecté. Essaie avec une meilleure photo ou le mode IA Vision.');
        }
        return text;
    }

    // ===== TEXT DISPLAY =====
    function displayText(text) {
        state.extractedText = text;
        const display = $('#text-display');

        // Apply settings
        display.style.fontSize = state.settings.fontSize + 'px';
        display.classList.toggle('no-dyslexic', !state.settings.dyslexicFont);
        display.classList.toggle('tight-lines', !state.settings.lineSpacing);
        document.documentElement.style.setProperty('--highlight', state.settings.highlightColor);

        // Split text into paragraphs and words
        display.innerHTML = '';
        state.words = [];

        const paragraphs = text.split(/\n\s*\n|\n/);

        paragraphs.forEach((para, pIdx) => {
            if (para.trim() === '') return;

            const p = document.createElement('p');
            p.style.marginBottom = '0.8em';

            const words = para.trim().split(/\s+/);
            words.forEach((word, wIdx) => {
                if (!word) return;

                const span = document.createElement('span');
                span.className = 'word';
                span.dataset.index = state.words.length;

                if (state.settings.syllables) {
                    // Simple French syllable splitting
                    const syllables = splitSyllables(word);
                    syllables.forEach((syl, sIdx) => {
                        const sylSpan = document.createElement('span');
                        sylSpan.className = 'syllable';
                        sylSpan.textContent = syl;
                        span.appendChild(sylSpan);
                    });
                } else {
                    span.textContent = word;
                }

                // Click on word: speak just that word and select it
                span.addEventListener('click', () => {
                    const idx = parseInt(span.dataset.index);
                    selectWord(idx);
                    speakSingleWord(state.words[idx].textContent);
                });

                state.words.push(span);
                p.appendChild(span);

                // Space between words
                if (wIdx < words.length - 1) {
                    p.appendChild(document.createTextNode(' '));
                }
            });

            display.appendChild(p);
        });
    }

    // Simple French syllable splitting (heuristic)
    function splitSyllables(word) {
        // Basic French syllabification rules
        const vowels = 'aeiouyàâäéèêëïîôùûüœæ';
        const result = [];
        let current = '';

        for (let i = 0; i < word.length; i++) {
            const ch = word[i].toLowerCase();
            current += word[i];

            if (vowels.includes(ch) && current.length >= 2) {
                // Look ahead — if next char is consonant + vowel, split before consonant
                if (i + 2 < word.length) {
                    const next = word[i + 1].toLowerCase();
                    const nextNext = word[i + 2].toLowerCase();
                    if (!vowels.includes(next) && vowels.includes(nextNext)) {
                        result.push(current);
                        current = '';
                        continue;
                    }
                    // Two consonants: split between them
                    if (!vowels.includes(next) && i + 3 < word.length && !vowels.includes(word[i + 2].toLowerCase())) {
                        result.push(current);
                        current = '';
                        continue;
                    }
                }
            }
        }

        if (current) {
            if (result.length > 0 && current.length <= 2 && !current.split('').some(c => vowels.includes(c.toLowerCase()))) {
                // Trailing consonants — attach to last syllable
                result[result.length - 1] += current;
            } else {
                result.push(current);
            }
        }

        return result.length > 0 ? result : [word];
    }

    // ===== TEXT-TO-SPEECH =====
    let synth = window.speechSynthesis;
    let voices = [];

    function loadVoices() {
        voices = synth.getVoices();
        populateVoiceSelect();
    }

    function populateVoiceSelect() {
        const select = $('#voice-select');
        const frenchVoices = voices.filter(v => v.lang.startsWith('fr'));
        select.innerHTML = '';

        if (frenchVoices.length === 0) {
            const opt = document.createElement('option');
            opt.textContent = 'Aucune voix française trouvée';
            opt.value = '';
            select.appendChild(opt);
            return;
        }

        frenchVoices.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v.name;
            opt.textContent = `${v.name} (${v.lang})`;
            if (v.name === state.settings.voiceName) opt.selected = true;
            select.appendChild(opt);
        });

        // Auto-select first French voice if none saved
        if (!state.settings.voiceName && frenchVoices.length > 0) {
            state.settings.voiceName = frenchVoices[0].name;
        }
    }

    function getSelectedVoice() {
        if (!state.settings.voiceName) return voices.find(v => v.lang.startsWith('fr')) || null;
        return voices.find(v => v.name === state.settings.voiceName) || voices.find(v => v.lang.startsWith('fr')) || null;
    }

    function selectWord(index) {
        clearSelection();
        if (index >= 0 && index < state.words.length) {
            state.selectedWordIndex = index;
            state.words[index].classList.add('selected');
            state.words[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    function clearSelection() {
        state.words.forEach(w => w.classList.remove('selected'));
        state.selectedWordIndex = -1;
    }

    function speakSingleWord(word) {
        synth.cancel();
        const utterance = new SpeechSynthesisUtterance(word);
        const voice = getSelectedVoice();
        if (voice) utterance.voice = voice;
        utterance.lang = 'fr-FR';
        utterance.rate = parseFloat($('#speed-slider').value);
        synth.speak(utterance);
    }

    // ===== OpenAI TTS =====
    async function speakWithOpenAITTS(text) {
        const apiKey = state.settings.apiKey;
        if (!apiKey) {
            showToast('Clé API nécessaire pour la voix IA');
            return null;
        }

        const response = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'tts-1',
                input: text,
                voice: state.settings.openaiVoice || 'nova',
                response_format: 'mp3',
                speed: parseFloat($('#speed-slider').value)
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error?.message || `Erreur TTS (${response.status})`);
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        return url;
    }

    // ===== DEMO TEXT =====
    const DEMO_TEXT = `Le petit chat dort sur le canapé. Il rêve de souris et de poissons. Quand il se réveille, il s'étire longuement et va boire un peu d'eau.

Aujourd'hui, c'est mercredi. Les enfants n'ont pas école l'après-midi. Léa et Tom décident d'aller jouer au parc avec leurs amis.

Le soleil brille dans le ciel bleu. Les oiseaux chantent dans les arbres. C'est une belle journée de printemps.`;

    function startSpeech() {
        if (state.words.length === 0) return;
        // If a word is selected, start from there
        const fromIndex = state.selectedWordIndex >= 0 ? state.selectedWordIndex : 0;
        startSpeechFromWord(fromIndex);
    }

    function startSpeechFromWord(index) {
        stopSpeech();
        clearSelection();

        const wordElements = state.words.slice(index);
        if (wordElements.length === 0) return;

        state.currentWordIndex = index;
        state.isPlaying = true;
        updatePlayButton();

        // Use OpenAI TTS if configured
        if (state.settings.ttsMethod === 'openai-tts' && state.settings.apiKey) {
            startOpenAITTSFromWord(index);
            return;
        }

        // Fallback: Web Speech API sentence-by-sentence
        startBrowserTTSFromWord(index);
    }

    // OpenAI TTS: generate audio for the full remaining text, play with estimated word tracking
    async function startOpenAITTSFromWord(index) {
        const text = state.words.slice(index).map(w => w.textContent).join(' ');

        try {
            highlightWord(index);
            const audioUrl = await speakWithOpenAITTS(text);
            if (!audioUrl || !state.isPlaying) return;

            const audio = new Audio(audioUrl);
            state.audioElement = audio;
            const speed = parseFloat($('#speed-slider').value);

            audio.addEventListener('play', () => {
                // Estimate total duration and schedule word highlights
                const totalWords = state.words.length - index;
                // Will re-schedule once we know actual duration
            });

            audio.addEventListener('loadedmetadata', () => {
                const duration = audio.duration * 1000; // ms
                const totalWords = state.words.length - index;
                const msPerWord = duration / totalWords;

                for (let i = 0; i < totalWords; i++) {
                    const timer = setTimeout(() => {
                        if (state.isPlaying) {
                            highlightWord(index + i);
                        }
                    }, i * msPerWord);
                    state._ttsTimers = state._ttsTimers || [];
                    state._ttsTimers.push(timer);
                }
            });

            audio.addEventListener('ended', () => {
                clearHighlight();
                state.isPlaying = false;
                state.currentWordIndex = -1;
                state.audioElement = null;
                updatePlayButton();
                URL.revokeObjectURL(audioUrl);
            });

            audio.addEventListener('error', () => {
                showToast('Erreur de lecture audio');
                state.isPlaying = false;
                state.audioElement = null;
                updatePlayButton();
            });

            audio.play();
        } catch (err) {
            showToast(err.message, 4000);
            // Fallback to browser TTS
            startBrowserTTSFromWord(index);
        }
    }

    // Browser TTS: sentence-by-sentence for natural sound + timer highlight
    function startBrowserTTSFromWord(index) {
        const sentences = [];
        let currentSentence = { startIndex: index, words: [] };

        for (let i = index; i < state.words.length; i++) {
            const text = state.words[i].textContent;
            currentSentence.words.push({ index: i, text: text });

            // Split on sentence-ending punctuation
            if (/[.!?;:…]$/.test(text) || i === state.words.length - 1) {
                sentences.push(currentSentence);
                currentSentence = { startIndex: i + 1, words: [] };
            }
        }

        let sentencePos = 0;

        function speakNextSentence() {
            if (!state.isPlaying || sentencePos >= sentences.length) {
                clearHighlight();
                state.isPlaying = false;
                state.currentWordIndex = -1;
                updatePlayButton();
                return;
            }

            const sentence = sentences[sentencePos];
            const sentenceText = sentence.words.map(w => w.text).join(' ');

            // Highlight first word of the sentence
            highlightWord(sentence.words[0].index);

            const utterance = new SpeechSynthesisUtterance(sentenceText);
            const voice = getSelectedVoice();
            if (voice) utterance.voice = voice;
            utterance.lang = 'fr-FR';
            utterance.rate = parseFloat($('#speed-slider').value);
            utterance.pitch = 1;

            // Timer-based word tracking within the sentence
            let wordTimers = [];
            const rate = utterance.rate;
            // Average word duration: ~300ms at rate 1.0
            const avgWordMs = 300 / rate;

            utterance.addEventListener('start', () => {
                // Schedule highlight for each word in the sentence
                sentence.words.forEach((w, i) => {
                    if (i === 0) return; // Already highlighted
                    const timer = setTimeout(() => {
                        if (state.isPlaying) {
                            highlightWord(w.index);
                        }
                    }, i * avgWordMs);
                    wordTimers.push(timer);
                });
            });

            // Also use boundary event as a more accurate source when available
            utterance.addEventListener('boundary', (event) => {
                if (event.name === 'word' && state.isPlaying) {
                    const spoken = sentenceText.substring(0, event.charIndex);
                    const spokenCount = spoken.split(/\s+/).filter(Boolean).length;
                    const wordIdx = Math.min(spokenCount, sentence.words.length - 1);
                    if (sentence.words[wordIdx]) {
                        // Cancel remaining timers — boundary is more accurate
                        wordTimers.forEach(t => clearTimeout(t));
                        wordTimers = [];
                        highlightWord(sentence.words[wordIdx].index);

                        // Reschedule remaining words
                        for (let j = wordIdx + 1; j < sentence.words.length; j++) {
                            const delay = (j - wordIdx) * avgWordMs;
                            const timer = setTimeout(() => {
                                if (state.isPlaying) {
                                    highlightWord(sentence.words[j].index);
                                }
                            }, delay);
                            wordTimers.push(timer);
                        }
                    }
                }
            });

            utterance.addEventListener('end', () => {
                wordTimers.forEach(t => clearTimeout(t));
                sentencePos++;
                speakNextSentence();
            });

            utterance.addEventListener('error', (e) => {
                wordTimers.forEach(t => clearTimeout(t));
                if (e.error !== 'canceled') {
                    sentencePos++;
                    speakNextSentence();
                }
            });

            state.utterance = utterance;
            synth.speak(utterance);
        }

        speakNextSentence();
    }

    function pauseSpeech() {
        if (state.audioElement) {
            state.audioElement.pause();
            state.isPlaying = false;
            updatePlayButton();
        } else if (synth.speaking) {
            synth.pause();
            state.isPlaying = false;
            updatePlayButton();
        }
    }

    function resumeSpeech() {
        if (state.audioElement && state.audioElement.paused) {
            state.audioElement.play();
            state.isPlaying = true;
            updatePlayButton();
        } else if (synth.paused) {
            synth.resume();
            state.isPlaying = true;
            updatePlayButton();
        }
    }

    function stopSpeech() {
        synth.cancel();
        // Stop OpenAI TTS audio if playing
        if (state.audioElement) {
            state.audioElement.pause();
            state.audioElement = null;
        }
        // Clear any scheduled highlight timers
        if (state._ttsTimers) {
            state._ttsTimers.forEach(t => clearTimeout(t));
            state._ttsTimers = [];
        }
        state.isPlaying = false;
        state.currentWordIndex = -1;
        clearHighlight();
        // Don't clear selection on stop — keep selected word for "play from here"
        updatePlayButton();
    }

    function togglePlayPause() {
        if (state.isPlaying) {
            pauseSpeech();
        } else if (synth.paused || (state.audioElement && state.audioElement.paused)) {
            resumeSpeech();
        } else {
            startSpeech();
        }
    }

    function updatePlayButton() {
        const btn = $('#btn-play');
        if (state.isPlaying) {
            btn.textContent = '⏸️ Pause';
        } else {
            btn.textContent = '▶️ Lire';
        }
    }

    function highlightWord(index) {
        clearHighlight();
        if (index >= 0 && index < state.words.length) {
            state.words[index].classList.add('active');
            state.currentWordIndex = index;

            // Scroll into view
            state.words[index].scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });
        }
    }

    function clearHighlight() {
        state.words.forEach(w => w.classList.remove('active'));
    }

    // ===== SETTINGS UI =====
    function applySettingsToUI() {
        $('#ocr-method').value = state.settings.ocrMethod;
        $('#api-key').value = state.settings.apiKey;
        $('#tts-method').value = state.settings.ttsMethod;
        $('#openai-voice').value = state.settings.openaiVoice;
        $('#default-speed').value = state.settings.speed;
        $('#default-speed-value').textContent = state.settings.speed + '×';
        $('#font-size').value = state.settings.fontSize;
        $('#font-size-value').textContent = state.settings.fontSize + 'px';
        $('#toggle-dyslexic-font').checked = state.settings.dyslexicFont;
        $('#toggle-syllables').checked = state.settings.syllables;
        $('#toggle-line-spacing').checked = state.settings.lineSpacing;
        $('#highlight-color').value = state.settings.highlightColor;
        $('#toggle-dark-mode').checked = state.settings.darkMode;
        $('#speed-slider').value = state.settings.speed;
        $('#speed-value').textContent = state.settings.speed + '×';

        // Toggle API key visibility
        $('#api-key-group').style.display = state.settings.ocrMethod === 'openai' ? 'block' : 'none';

        // Toggle voice options visibility
        const isTTSOpenAI = state.settings.ttsMethod === 'openai-tts';
        $('#browser-voice-group').style.display = isTTSOpenAI ? 'none' : 'block';
        $('#openai-voice-group').style.display = isTTSOpenAI ? 'block' : 'none';

        // Dark mode
        document.body.classList.toggle('dark-mode', state.settings.darkMode);
    }

    function saveSettingsFromUI() {
        state.settings.ocrMethod = $('#ocr-method').value;
        state.settings.apiKey = $('#api-key').value.trim();
        state.settings.ttsMethod = $('#tts-method').value;
        state.settings.openaiVoice = $('#openai-voice').value;
        state.settings.voiceName = $('#voice-select').value;
        state.settings.speed = parseFloat($('#default-speed').value);
        state.settings.fontSize = parseInt($('#font-size').value);
        state.settings.dyslexicFont = $('#toggle-dyslexic-font').checked;
        state.settings.syllables = $('#toggle-syllables').checked;
        state.settings.lineSpacing = $('#toggle-line-spacing').checked;
        state.settings.highlightColor = $('#highlight-color').value;
        state.settings.darkMode = $('#toggle-dark-mode').checked;

        saveSettings();
        applySettingsToUI();
        showToast('Réglages enregistrés ✓');
    }

    // ===== EVENT LISTENERS =====
    function init() {
        // Load voices
        loadVoices();
        if (synth.onvoiceschanged !== undefined) {
            synth.onvoiceschanged = loadVoices;
        }

        // Apply settings
        applySettingsToUI();

        // === Camera / File input ===
        $('#camera-input').addEventListener('change', (e) => {
            if (e.target.files[0]) handleImageSelected(e.target.files[0]);
            e.target.value = ''; // reset for same file
        });

        $('#file-input').addEventListener('change', (e) => {
            if (e.target.files[0]) handleImageSelected(e.target.files[0]);
            e.target.value = '';
        });

        // === Paste text ===
        $('#btn-paste').addEventListener('click', () => showScreen('paste'));

        // === Demo mode ===
        $('#btn-demo').addEventListener('click', () => {
            displayText(DEMO_TEXT);
            showScreen('reader');
            showToast('Texte de démo chargé — appuie sur ▶️ Lire');
        });

        $('#btn-read-pasted').addEventListener('click', () => {
            const text = $('#paste-textarea').value.trim();
            if (!text) {
                showToast('Tape ou colle du texte d\'abord');
                return;
            }
            displayText(text);
            showScreen('reader');
        });

        // === Extract text from image ===
        $('#btn-extract').addEventListener('click', async () => {
            showScreen('loading');
            $('#loading-message').textContent = 'Lecture du document en cours...';

            try {
                let image = state.currentImage;

                // Enhance if toggled
                if ($('#toggle-enhance').checked) {
                    $('#loading-message').textContent = 'Amélioration de l\'image...';
                    image = await enhanceImage(image);
                }

                const text = await extractText(image);
                displayText(text);
                showScreen('reader');
            } catch (err) {
                showToast(err.message, 4000);
                showScreen('preview');
            }
        });

        // === Reader controls ===
        $('#btn-play').addEventListener('click', togglePlayPause);

        $('#btn-restart').addEventListener('click', () => {
            stopSpeech();
            startSpeech();
        });

        $('#btn-stop').addEventListener('click', stopSpeech);

        $('#speed-slider').addEventListener('input', (e) => {
            $('#speed-value').textContent = e.target.value + '×';
            // If currently speaking, restart with new speed
            if (state.isPlaying && state.currentWordIndex >= 0) {
                startSpeechFromWord(state.currentWordIndex);
            }
        });

        // === Copy text ===
        $('#btn-copy-text').addEventListener('click', () => {
            if (state.extractedText) {
                navigator.clipboard.writeText(state.extractedText).then(() => {
                    showToast('Texte copié ✓');
                }).catch(() => {
                    showToast('Impossible de copier');
                });
            }
        });

        // === Navigation ===
        $('#btn-settings').addEventListener('click', () => showScreen('settings'));
        $('#btn-back-preview').addEventListener('click', () => showScreen('home'));
        $('#btn-back-reader').addEventListener('click', () => {
            stopSpeech();
            showScreen('home');
        });
        $('#btn-back-paste').addEventListener('click', () => showScreen('home'));
        $('#btn-back-settings').addEventListener('click', () => showScreen('home'));

        // === Settings ===
        $('#ocr-method').addEventListener('change', () => {
            $('#api-key-group').style.display = $('#ocr-method').value === 'openai' ? 'block' : 'none';
        });

        $('#tts-method').addEventListener('change', () => {
            const isTTSOpenAI = $('#tts-method').value === 'openai-tts';
            $('#browser-voice-group').style.display = isTTSOpenAI ? 'none' : 'block';
            $('#openai-voice-group').style.display = isTTSOpenAI ? 'block' : 'none';
        });

        $('#default-speed').addEventListener('input', (e) => {
            $('#default-speed-value').textContent = e.target.value + '×';
        });

        $('#font-size').addEventListener('input', (e) => {
            $('#font-size-value').textContent = e.target.value + 'px';
        });

        $('#btn-save-settings').addEventListener('click', () => {
            saveSettingsFromUI();
            showScreen('home');
        });

        // === Keyboard shortcuts ===
        document.addEventListener('keydown', (e) => {
            if (screens.reader.classList.contains('active')) {
                if (e.code === 'Space') {
                    e.preventDefault();
                    togglePlayPause();
                } else if (e.code === 'Escape') {
                    stopSpeech();
                }
            }
        });

        // === PWA install prompt ===
        let deferredPrompt;
        window.addEventListener('beforeinstallprompt', (e) => {
            deferredPrompt = e;
        });

        // Register service worker
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js').catch(() => {});
        }

        console.log('LectoDys initialisé ✓');
    }

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
