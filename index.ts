import * as dotenv from 'dotenv';
import { Client, LocalAuth, Poll } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

let TARGET_CHAT_ID: string | undefined = process.env.TARGET_CHAT_ID;
const AREAS_TO_MONITOR: string[] = process.env.AREAS_TO_MONITOR
    ? process.env.AREAS_TO_MONITOR.split(',').map(a => a.trim())
    : [];
const POLL_INTERVAL: number = parseInt(process.env.POLL_INTERVAL || '2000');
const EVENT_SILENCE_MINUTES: number = parseInt(process.env.EVENT_SILENCE_MINUTES || '10', 10);

if (!TARGET_CHAT_ID) {
    console.warn("WARNING: TARGET_CHAT_ID is not set in .env.");
}

if (AREAS_TO_MONITOR.length === 0) {
    console.warn("WARNING: AREAS_TO_MONITOR is not set in .env. Defaults to listening to all areas.");
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

client.on('qr', (qr: string) => {
    console.log('Please scan this QR code with your WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('WhatsApp client is ready!');

    const areasStr = AREAS_TO_MONITOR.length > 0
        ? '\n- ' + AREAS_TO_MONITOR.join('\n- ')
        : 'ALL';

    if (!TARGET_CHAT_ID) {
        console.log('\n--- Helper: Quick Chat Setup ---');
        console.log('TARGET_CHAT_ID is not set in your .env file.');
        console.log('To set it up instantly, just send the message "!here"');
        console.log('to this WhatsApp account from the chat or group you want to monitor.');
        console.log('I will automatically capture the ID, save it, and start monitoring!');
        console.log('--------------------------------\n');
    } else {
        console.log(`Monitoring areas: ${areasStr}`);
        startPikudHaorefPolling();
    }
});

client.on('message', async (msg) => {
    if (msg.body === '!testpoll') {
        sendPoll(msg.from, ['אזור בדיקה']);
    }

    if (msg.body === '!here' && !TARGET_CHAT_ID) {
        TARGET_CHAT_ID = msg.from;

        const envPath = path.resolve(process.cwd(), '.env');
        let envContent = '';
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf8');
        }

        if (envContent.includes('TARGET_CHAT_ID=')) {
            envContent = envContent.replace(/TARGET_CHAT_ID=.*/g, `TARGET_CHAT_ID=${TARGET_CHAT_ID}`);
        } else {
            envContent += `\nTARGET_CHAT_ID=${TARGET_CHAT_ID}\n`;
        }

        fs.writeFileSync(envPath, envContent, 'utf8');

        console.log(`✅ Chat ID successfully captured: ${TARGET_CHAT_ID}`);
        console.log(`✅ Saved directly to .env file!\n`);

        const areasStr = AREAS_TO_MONITOR.length > 0
            ? '\n- ' + AREAS_TO_MONITOR.join('\n- ')
            : 'כל הארץ';

        await msg.reply(`✅ הבוט קושר בהצלחה לצ'אט וינטר אחר אזעקות באזורי ההתרעה: ${areasStr} \n שמרו על עצמכם!`);

        startPikudHaorefPolling();
    }
});

client.initialize();

let isEventActive: boolean = false;
let currentEventAreas: Set<string> = new Set();
let eventResetTimeout: NodeJS.Timeout | null = null;
let currentEventOriginalPoll: any = null;
const EVENT_SILENCE_TIMEOUT_MS = EVENT_SILENCE_MINUTES * 60 * 1000;

let processedAlertIds: string[] = [];

function startPikudHaorefPolling() {
    console.log('Starting polling for alerts...');

    const url = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
    const headers = {
        'Referer': 'https://www.oref.org.il/',
        'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.97 Safari/537.36",
        'X-Requested-With': 'XMLHttpRequest'
    };

    const pollApi = async function () {
        try {
            const response = await axios.get(url, {
                headers,
                responseType: 'arraybuffer',
                timeout: 5000
            });

            let alert_data = Buffer.from(response.data).toString('utf8');
            // Remove BOM if present
            if (alert_data.charCodeAt(0) === 0xFEFF) {
                alert_data = alert_data.slice(1);
            }
            alert_data = alert_data.replace(/\x00/g, '').trim();

            if (alert_data && alert_data !== '') {
                // Ignore HTML error pages if the WAF blocked us
                if (alert_data.includes('<html') || alert_data.includes('errorpage')) {
                    throw new Error('Received HTML error page from WAF');
                }

                let alert;
                try {
                    alert = JSON.parse(alert_data);
                } catch (e) {
                    console.log('⚠️  Warning: Received malformed JSON from API (Server under load). Re-polling...');
                    return;
                }

                if (alert && alert.id && !processedAlertIds.includes(alert.id)) {
                    processedAlertIds.push(alert.id);
                    if (processedAlertIds.length > 50) processedAlertIds.shift();

                    const cities: string[] = alert ? (alert.data || []) : [];

                    const triggeredAreas = AREAS_TO_MONITOR.length === 0
                        ? cities
                        : cities.filter(city => AREAS_TO_MONITOR.includes(city));

                    const isSafeToLeaveData = alert.data && alert.data.some((d: string) => d.includes('ניתן לצאת מהמרחב המוגן'));

                    const isSafeToLeaveTitle = alert.title && (alert.title.includes('ניתן לצאת') || alert.title.includes('האירוע הסתיים'));

                    const isRocketAttack = alert.title && alert.title.includes('ירי רקטות וטילים');

                    const isValidTrigger = triggeredAreas.length > 0 && isRocketAttack && !isSafeToLeaveData && !isSafeToLeaveTitle;

                    if (isValidTrigger) {
                        if (eventResetTimeout) {
                            clearTimeout(eventResetTimeout);
                            eventResetTimeout = null;
                        }

                        const newlyTriggeredAreas = triggeredAreas.filter(area => !currentEventAreas.has(area));
                        triggeredAreas.forEach(area => currentEventAreas.add(area));

                        if (!isEventActive) {
                            console.log(`🚨 NEW EVENT DETECTED in monitored area! Cities: ${triggeredAreas.join(', ')} 🚨`);
                            isEventActive = true;

                            if (TARGET_CHAT_ID) {
                                sendPoll(TARGET_CHAT_ID, triggeredAreas).then(pollMsg => {
                                    if (pollMsg) {
                                        currentEventOriginalPoll = pollMsg;
                                    }
                                });
                            } else {
                                console.log("Cannot send poll, target chat ID is not configured.");
                            }

                        } else if (newlyTriggeredAreas.length > 0) {
                            console.log(`📡 Continuing event, new areas hit: ${newlyTriggeredAreas.join(', ')} 📡`);
                            sendNewAreaMessage(newlyTriggeredAreas, currentEventOriginalPoll);
                        } else {
                            console.log(`📡 Continuing event in monitored area (no new areas). Cities: ${triggeredAreas.join(', ')} 📡`);
                        }
                    }
                }
            } else {
                if (isEventActive && !eventResetTimeout) {
                    console.log(`⏳ Area went quiet. Starting ${EVENT_SILENCE_TIMEOUT_MS / 60000} minute countdown to reset event...`);

                    eventResetTimeout = setTimeout(() => {
                        console.log(`✅ ${EVENT_SILENCE_MINUTES} minutes of silence passed. Event officially ended.`);
                        isEventActive = false;
                        currentEventAreas.clear();
                        currentEventOriginalPoll = null;
                        eventResetTimeout = null;
                    }, EVENT_SILENCE_TIMEOUT_MS);
                }
            }
        } catch (err: any) {
            if (err.code !== 'ECONNABORTED') {
            }
        } finally {
            setTimeout(pollApi, POLL_INTERVAL);
        }
    };

    pollApi();
}

async function sendNewAreaMessage(areas: string[], originalPollMsg?: any) {
    const targetId = TARGET_CHAT_ID;
    if (!targetId) return;

    try {
        const areaString = areas.join(', ');
        const message = `🚨 *האזעקה התרחבה לאזורים*: ${areaString}`;

        if (originalPollMsg) {
            await originalPollMsg.reply(message);
        } else {
            await client.sendMessage(targetId, message);
        }
        console.log(`Sent message for new areas: ${areaString}`);
    } catch (error) {
        console.error('Failed to send new area message:', error);
    }
}

async function sendPoll(chatId: string, areas: string[] = []) {
    console.log(`Sending poll to ${chatId}...`);
    try {
        const areaString = areas.length > 0 ? ` (${areas.join(', ')})` : '';
        const pollTitle = `🚨 אזעקת צבע אדום${areaString}\nהאם כולם במרחב המוגן?`;

        // @ts-ignore - whatsapp-web.js types incorrectly mark messageSecret as required
        const poll = new Poll(pollTitle, ['בממ״ד 🛡️', 'אין פה אזעקה 🤫'], { allowMultipleAnswers: false });
        const msg = await client.sendMessage(chatId, poll);
        console.log('Poll sent successfully!');
        return msg;
    } catch (error) {
        console.error('Failed to send poll:', error);
        return null;
    }
}

process.on('SIGINT', async () => {
    console.log('(SIGINT) Shutting down...');
    await client.destroy();
    process.exit(0);
});
