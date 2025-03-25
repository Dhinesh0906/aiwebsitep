
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const gTTS = require('gtts');
const { execSync } = require('child_process');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));
app.use('/videos', express.static('videos'));

const MISTRAL_API_KEY = 'xGrzqUd5CFMlXtJ4ZOc9xYXMr2RYH0vF';
const UNSPLASH_ACCESS_KEY = '5nsrkXUA1Ha_RIK69cYQCAW7OTBIpMKhpnfgxjpBmJ4';

async function generateContent(topic, duration) {
  const prompt = `Create a structured educational explanation on "${topic}" to be explained in about ${duration} minutes. Include key concepts, subtopics, and examples.`;
  const response = await axios.post(
    'https://api.mistral.ai/v1/chat/completions',
    {
      model: 'mistral-medium',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7
    },
    {
      headers: {
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data.choices[0].message.content;
}

async function translateText(text, targetLang) {
  const response = await axios.post('https://libretranslate.de/translate', {
    q: text,
    source: 'en',
    target: targetLang,
    format: 'text'
  });
  return response.data.translatedText;
}

async function generateSummary(content, lang) {
  const prompt = `Summarize the following explanation into 3-5 key points:\n\n${content}`;
  const response = await axios.post(
    'https://api.mistral.ai/v1/chat/completions',
    {
      model: 'mistral-medium',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5
    },
    {
      headers: {
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  const summary = response.data.choices[0].message.content;
  return await translateText(summary, lang);
}

function generateSubtitles(text, srtPath) {
  const lines = text.match(/.{1,60}(\s|$)/g);
  const srt = lines.map((line, i) => {
    const start = new Date(i * 5 * 1000).toISOString().substr(11, 8) + ",000";
    const end = new Date((i + 1) * 5 * 1000).toISOString().substr(11, 8) + ",000";
    return `${i + 1}\n${start} --> ${end}\n${line.trim()}\n`;
  }).join('\n');
  fs.writeFileSync(srtPath, srt);
}

async function generateAudio(text, lang, outputPath) {
  const chunks = text.match(/.{1,200}(\s|$)/g);
  const tempFiles = [];
  for (let i = 0; i < chunks.length; i++) {
    const tempPath = `audio/temp-${i}.mp3`;
    const tts = new gTTS(chunks[i], lang);
    await new Promise((resolve, reject) => {
      tts.save(tempPath, (err) => (err ? reject(err) : resolve()));
    });
    tempFiles.push(tempPath);
  }
  const concatList = 'audio/concat.txt';
  fs.writeFileSync(concatList, tempFiles.map(f => `file '${path.resolve(f)}'`).join('\n'));
  execSync(`ffmpeg -y -f concat -safe 0 -i ${concatList} -c copy ${outputPath}`);
  tempFiles.forEach(f => fs.unlinkSync(f));
  fs.unlinkSync(concatList);
}

async function downloadImages(topic, count) {
  const imagePaths = [];
  for (let i = 0; i < count; i++) {
    const res = await fetch(`https://api.unsplash.com/photos/random?query=${encodeURIComponent(topic)}&client_id=${UNSPLASH_ACCESS_KEY}`);
    const data = await res.json();
    const imgRes = await fetch(data.urls.regular);
    const imagePath = `slides/${Date.now()}-img-${i}.jpg`;
    const stream = fs.createWriteStream(imagePath);
    await new Promise((resolve, reject) => {
      imgRes.body.pipe(stream);
      imgRes.body.on('error', reject);
      stream.on('finish', resolve);
    });
    imagePaths.push(imagePath);
  }
  return imagePaths;
}

function createSlideshow(images, summaryImage, outputPath) {
  const listFile = 'slides/images.txt';
  const slides = images.map(img => `file '${path.resolve(img)}'\nduration 5`).join('\n');
  const final = `file '${path.resolve(summaryImage)}'\nduration 7\nfile '${path.resolve(summaryImage)}'`;
  fs.writeFileSync(listFile, slides + '\n' + final);
  execSync(`ffmpeg -y -f concat -safe 0 -i ${listFile} -vsync vfr -pix_fmt yuv420p ${outputPath}`);
}

function mergeToVideo(videoPath, audioPath, srtPath, finalPath) {
  execSync(`ffmpeg -y -i ${videoPath} -i ${audioPath} -vf subtitles=${srtPath} -shortest -c:v libx264 -c:a aac -pix_fmt yuv420p ${finalPath}`);
}

app.post('/generate-video', async (req, res) => {
  const { topic, duration, language } = req.body;

  console.log('📥 Request body received:', req.body);

  if (!topic || !duration || !language) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  console.log('🎯 Topic:', topic, '| Duration:', duration, '| Language:', language);

  try {
    const content = await generateContent(topic, duration);
    console.log('✅ Content generated');

    const translated = await translateText(content, language);
    console.log('🌍 Translated content');

    const summary = await generateSummary(content, language);
    console.log('📝 Summary generated');

    const totalSeconds = parseFloat(duration) * 60;
    const imageCount = Math.ceil(totalSeconds / 5);
    const images = await downloadImages(topic, imageCount);
    console.log(`🖼 ${images.length} images downloaded`);

    const summaryImage = `slides/${Date.now()}-summary.jpg`;
    fs.writeFileSync(summaryImage, summary);
    console.log('🖼 Summary image created');

    const slideVideoPath = `slides/${Date.now()}-slideshow.mp4`;
    createSlideshow(images, summaryImage, slideVideoPath);
    console.log('🎞 Slideshow created');

    const audioPath = `audio/${Date.now()}-voice.mp3`;
    await generateAudio(translated, language, audioPath);
    console.log('🔊 Audio created');

    const srtPath = `subtitles/${Date.now()}.srt`;
    generateSubtitles(content, srtPath);
    console.log('📄 Subtitles generated');

    const finalVideoPath = `videos/${Date.now()}-final.mp4`;
    mergeToVideo(slideVideoPath, audioPath, srtPath, finalVideoPath);
    console.log('✅ Final video created');

    res.json({ videoUrl: `/videos/${path.basename(finalVideoPath)}` });

  } catch (err) {
    console.error('❌ FULL ERROR:', err);
    res.status(500).json({ error: 'Video generation failed.', details: err.message });
  }
});


app.listen(3000, () => console.log('🚀 Server running at http://localhost:3000'));
