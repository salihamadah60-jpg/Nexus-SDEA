import StreamZip from 'node-stream-zip';
import fs from 'fs';
import path from 'path';

async function extract() {
    const targetDir = '/UpdateNexus/extracted';
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    try {
        const zip1 = new StreamZip.async({ file: '/UpdateNexus/OpenHands.zip' });
        await zip1.extract(null, path.join(targetDir, 'OpenHands'));
        await zip1.close();
        console.log('Extracted OpenHands');

        const zip2 = new StreamZip.async({ file: '/UpdateNexus/KOcrrZSHbXMQAuan.zip' });
        await zip2.extract(null, path.join(targetDir, 'GPTPilot'));
        await zip2.close();
        console.log('Extracted GPTPilot');
    } catch (err) {
        console.error('Extraction failed:', err);
    }
}

extract();
