This is the app for GLASS-1, a pair of smart glasses that takes in from your brain, camera, and mic, and uses it to do everything from control your smart home to having the answer to any question you see on demand. 

GLASS 1's hardware is built of the Muse 2 headset. The headset allows you to create a bluetooth stream of various data, this includes an array of EEG electrodes, an accelerometer and gyroscope, and a PPG Sensor (which won't really be used for this project)

There's also some other hardware we need for the system to work. The OV5640 Camera is mounted to the front side of the headset, so the sw can see exactly what the person is seeing. Additionly, the microphone from the macbook the app is being used for audio input as it's just easier for this purpose.

Item | Link | Price
Muse 2 Headset | https://choosemuse.com/products/muse-2? | 249.99
OV5640 Camera | https://www.amazon.com/dp/B0C47JZD9L?ref=ppx_yo2ov_dt_b_fed_asin_title | 10.91
PLA Filament | https://www.amazon.com/dp/B0FFY156Z7/ref=vp_d_cpf-substitute-widget-prsubs_pd?_encoding=UTF8&pf_rd_p=3b384b6f-3e1a-4384-bf9e-527aad01ce71&pf_rd_r=ANVG2G0J3TB1MQV7X134&pd_rd_wg=jewxk&pd_rd_i=B0FFY156Z7&pd_rd_w=jGVxU&content-id=amzn1.sym.3b384b6f-3e1a-4384-bf9e-527aad01ce71&pd_rd_r=f7a13acb-8fa4-47f7-b45c-508e10038d62&th=1 | 7.99


The software is a desktop app, specifically built on electron. The app handles connecting to the hardware, including the usb camera stream and the bluetooth streams.

Usage of the app is as follows:

- Download the most recent release availabile to you
- Drag and drop teh app into you applications folder
- Connect the harwdare via the conenction tab
- 

How it works:

The flow between input and output is a little long, so here's a chart I made in figma to help understand it.

<img width="695" height="817" alt="Screenshot 2026-06-17 at 4 31 14 PM" src="https://github.com/user-attachments/assets/f780d538-43f8-4042-b4df-d4e3c781ddc3" />


