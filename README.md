What is GLASS-1: 

GLASS-1 is a pair of smart glasses that takes in data from your brain, camera, and mic, and uses it to do everything from control your smart home to having the answer to any question you see in seconds. By putting the device on your head and opening the app the app on the Raspberry Pi companion, you can control anything around you by thinking and moving. I made GLASS-1 because using touchscreens and keybaords constantly just sucks. Having access to an assitant in your conversation by thinking, or being able to turn off and on light by just looking at them and think "on" or "off" feels like superpowers.

Here's a diagram of the wiring/connections:
<img width="1344" height="497" alt="Screenshot 2026-06-18 at 11 41 07 AM" src="https://github.com/user-attachments/assets/3efbd930-4d6e-45a2-b953-87d38c09e67a" />


Here's an image of Glass-1 and the Glass-1 Hub:

<img width="1204" height="638" alt="Screenshot 2026-06-18 at 11 46 09 AM" src="https://github.com/user-attachments/assets/57b15ad6-cab6-4bf0-9a3b-0fa83d114f3a" />

Usage of the app is as follows:

- Download the most recent release availabile to you
- Drag and drop teh app into you applications folder
- Connect the harwdare via the conenction tab

How it works:

GLASS 1's hardware is built of the Muse 2 headset. The headset allows you to create a bluetooth stream of various data, this includes an array of EEG electrodes, an accelerometer and gyroscope, and a PPG Sensor (which won't really be used for this project). The software is a desktop app, specifically built on electron. The app handles connecting to the hardware, including the usb camera stream and the bluetooth streams. Glass runs on the Glass-1 Hub, a Raspberry Pi with a custom mount to strap it to users' arms and a mechanical structure to hold up it's diplay.

The flow between input and output is a little long, so here's a chart I made to help explain it. In short, the various inputs are collected and processed in different ways, which allows you to control devices and AI.

<img width="983" height="601" alt="image" src="https://github.com/user-attachments/assets/2666cbb2-8aa7-40de-90ec-44f2c2531c7f" />

The BOM for the project can be found in the repo.


And finally, here's the poster for this project:

<img width="1410" height="2000" alt="GLASS - 1 (4)" src="https://github.com/user-attachments/assets/fc8d9ffc-9e3a-4e8d-92d4-eb0fb852ce2e" />





