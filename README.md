What is GLASS-1: 

GLASS-1 is a pair of smart glasses that takes in data from your brain, camera, and mic, and uses it to do everything from control your smart home to having the answer to any question you see in seconds. By putting the device on your head and opening the app, you can control anything around you by thinking and moving. I made GLASS-1 because using touchscreens and keybaords constantly just sucks. Having access to an assitant in your conversation by thinking, or being able to turn off and on light by jsut looking at them and think "on" or "off" feels like superpowers.

Here's what the headset looks like:
<img width="1281" height="560" alt="Screenshot 2026-06-17 at 4 39 05 PM" src="https://github.com/user-attachments/assets/9555152b-2fad-4759-8cd1-105dd4013cf4" />

Here's a diagram of the wiring/connections:
<img width="1508" height="391" alt="Screenshot 2026-06-17 at 4 46 10 PM" src="https://github.com/user-attachments/assets/7d4859b2-f482-4d9f-8e40-baef3bb953c9" />

Here's a BOM of the project (it's pretty simple)
| Item | Link | Price |
| --- | --- | --- |
| Muse 2 Headset | https://choosemuse.com/products/muse-2? | 249.99 |
| OV5640 Camera | https://www.amazon.com/dp/B0C47JZD9L?ref=ppx_yo2ov_dt_b_fed_asin_title | 10.91 |
| PLA Filament | https://www.amazon.com/dp/B0FFY156Z7/ref=vp_d_cpf-substitute-widget-prsubs_pd?_encoding=UTF8&pf_rd_p=3b384b6f-3e1a-4384-bf9e-527aad01ce71&pf_rd_r=ANVG2G0J3TB1MQV7X134&pd_rd_wg=jewxk&pd_rd_i=B0FFY156Z7&pd_rd_w=jGVxU&content-id=amzn1.sym.3b384b6f-3e1a-4384-bf9e-527aad01ce71&pd_rd_r=f7a13acb-8fa4-47f7-b45c-508e10038d62&th=1 | 7.99 |

This is also avaibile as a CSV in the repo

GLASS 1's hardware is built of the Muse 2 headset. The headset allows you to create a bluetooth stream of various data, this includes an array of EEG electrodes, an accelerometer and gyroscope, and a PPG Sensor (which won't really be used for this project). The software is a desktop app, specifically built on electron. The app handles connecting to the hardware, including the usb camera stream and the bluetooth streams.

Usage of the app is as follows:

- Download the most recent release availabile to you
- Drag and drop teh app into you applications folder
- Connect the harwdare via the conenction tab

How it works:

The flow between input and output is a little long, so here's a chart I made to help explain it. In short, the various inputs are collected and processed in different ways, which allows you to control devices and AI.

<img width="983" height="601" alt="image" src="https://github.com/user-attachments/assets/2666cbb2-8aa7-40de-90ec-44f2c2531c7f" />

And here's an awesome poster that I designed for the project:
<img width="1410" height="2000" alt="GLASS - 1 (3)" src="https://github.com/user-attachments/assets/ccace629-f7e7-4f80-93a5-a93612df5b59" />




