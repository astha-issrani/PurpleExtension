const API = 'https://purple-streaming.onrender.com';

let mediaRecorder = null;
let recordedChunks = [];
let timerInterval = null;
let seconds = 0;
let token = null;
let stream = null;
let micStream = null;

// Elements
const authSection     = document.getElementById('auth-section');
const recorderSection = document.getElementById('recorder-section');
const loginBtn        = document.getElementById('login-btn');
const startBtn        = document.getElementById('start-btn');
const stopBtn         = document.getElementById('stop-btn');
const logoutBtn       = document.getElementById('logout-btn');
const statusDot       = document.getElementById('status-dot');
const statusText      = document.getElementById('status-text');
const timerEl         = document.getElementById('timer');
const messageEl       = document.getElementById('message');
const progressWrap    = document.getElementById('progress-wrap');
const progressBar     = document.getElementById('progress-bar');

// Check saved token on open
chrome.storage.local.get(['token'], (result) => {
  if (result.token) {
    token = result.token;
    showRecorder();
  }
});

// Login
loginBtn.addEventListener('click', async () => {
  const email    = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value.trim();

  if (!email || !password) return showMessage('Please enter email and password', 'error');

  loginBtn.textContent = 'Logging in...';
  loginBtn.disabled = true;

  try {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Login failed');

    token = data.token;
    chrome.storage.local.set({ token: data.token }, () => {
      showRecorder();
    });

  } catch (err) {
    showMessage(err.message, 'error');
    loginBtn.textContent = 'Login to PurpleStream';
    loginBtn.disabled = false;
  }
});

// Logout
logoutBtn.addEventListener('click', () => {
  chrome.storage.local.remove('token', () => {
    token = null;
    authSection.style.display = 'block';
    recorderSection.style.display = 'none';
  });
});

// Start Recording
startBtn.addEventListener('click', async () => {
  const title = document.getElementById('title').value.trim();
  if (!title) return showMessage('Please enter a title first', 'error');

  try {
    // Get mic audio separately
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Get screen + system audio
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 44100
      }
    });

    // Mix system audio + mic audio using AudioContext
    const audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();

    // Add system audio if available
    if (stream.getAudioTracks().length > 0) {
      const systemSource = audioContext.createMediaStreamSource(stream);
      systemSource.connect(destination);
    }

    // Add mic audio
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(destination);

    // Final combined stream (video + mixed audio)
    const combinedStream = new MediaStream([
      ...stream.getVideoTracks(),
      ...destination.stream.getAudioTracks()
    ]);

    recordedChunks = [];
    mediaRecorder = new MediaRecorder(combinedStream, {
      mimeType: 'video/webm;codecs=vp9,opus'
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      micStream.getTracks().forEach(t => t.stop());
      uploadVideo();
    };

    // If user stops sharing from Chrome's own stop button
    stream.getVideoTracks()[0].onended = () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        micStream.getTracks().forEach(t => t.stop());
        mediaRecorder.stop();
        stopTimer();
        statusDot.className = 'status-dot';
        statusText.textContent = 'Processing...';
        startBtn.disabled = true;
        stopBtn.disabled = true;
        showMessage('Preparing upload...', '');
      }
    };

    chrome.storage.local.set({ isRecording: true, recordingTitle: title });

    mediaRecorder.start(1000);

    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusDot.className = 'status-dot recording';
    statusText.textContent = 'Recording...';
    showMessage('✅ Recording in progress — you can switch tabs!', '');
    startTimer();

  } catch (err) {
    showMessage('Could not start recording: ' + err.message, 'error');
  }
});

// Stop Recording
stopBtn.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    chrome.storage.local.set({ isRecording: false });
    mediaRecorder.stop();
    stopTimer();
    statusDot.className = 'status-dot';
    statusText.textContent = 'Processing...';
    startBtn.disabled = true;
    stopBtn.disabled = true;
    showMessage('Preparing upload...', '');
  }
});

// Upload Video
async function uploadVideo() {
  const title       = document.getElementById('title').value.trim();
  const description = document.getElementById('description').value.trim();

  const blob = new Blob(recordedChunks, { type: 'video/webm' });
  const filename = `${title.replace(/\s+/g, '-')}-${Date.now()}.webm`;
  const file = new File([blob], filename, { type: 'video/webm' });

  const formData = new FormData();
  formData.append('video', file);
  formData.append('title', title);
  formData.append('description', description);

  progressWrap.style.display = 'block';
  showMessage('Uploading to PurpleStream...', '');

  try {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          progressBar.style.width = pct + '%';
          showMessage(`Uploading... ${pct}%`, '');
        }
      };

      xhr.onload = () => {
        if (xhr.status === 201) resolve();
        else reject(new Error('Upload failed: ' + xhr.responseText));
      };

      xhr.onerror = () => reject(new Error('Network error'));

      xhr.open('POST', `${API}/api/videos/upload`);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.send(formData);
    });

    progressBar.style.width = '100%';
    showMessage('✅ Uploaded successfully!', 'success');
    statusDot.className = 'status-dot ready';
    statusText.textContent = 'Ready to record';
    timerEl.textContent = '00:00';
    startBtn.disabled = false;
    document.getElementById('title').value = '';
    document.getElementById('description').value = '';
    chrome.storage.local.set({ isRecording: false });

    setTimeout(() => {
      progressWrap.style.display = 'none';
      progressBar.style.width = '0%';
    }, 3000);

  } catch (err) {
    showMessage('❌ ' + err.message, 'error');
    startBtn.disabled = false;
    statusText.textContent = 'Ready to record';
  }
}

// Timer
function startTimer() {
  seconds = 0;
  timerInterval = setInterval(() => {
    seconds++;
    const m = String(Math.floor(seconds / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    timerEl.textContent = `${m}:${s}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
}

// Helpers
function showRecorder() {
  authSection.style.display = 'none';
  recorderSection.style.display = 'block';
}

function showMessage(msg, type) {
  messageEl.textContent = msg;
  messageEl.className = type;
}