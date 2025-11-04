/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2025 Bjoern Boss Henrichsen */
function PushNotification(text, error, onreload) {
	const host = document.getElementById('notification-host');

	/* create the new notification */
	const notification = document.createElement('div');
	notification.classList.add('notification');

	/* add the caption */
	const caption = document.createElement('div');
	notification.appendChild(caption);
	caption.classList.add('text');
	if (error)
		caption.classList.add('error');
	caption.innerText = text;

	/* add the splitter */
	const splitter = document.createElement('div');
	notification.appendChild(splitter);
	splitter.classList.add('splitter');

	/* add the close/reload button */
	const button = document.createElement('div');
	notification.appendChild(button);
	button.classList.add('button');
	button.innerText = (onreload != null ? '\u27f3' : '\u2716');
	if (onreload != null) {
		button.style.fontWeight = '800';
		button.style.fontSize = '1.5em';
	}
	button.onclick = function () {
		notification.remove();
		if (onreload != null)
			onreload();
	};

	/* append the notification */
	host.appendChild(notification);
}
