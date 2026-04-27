# slou.ch — Setup Instructions

## 1. Copy files to server

```bash
# From your Mac, copy the project to your droplet:
scp -r /path/to/slouch ghostuser@144.126.236.254:~/slouch-app

# SSH into the droplet:
ssh trocp
su - ghostuser
```

## 2. Install dependencies

```bash
cd ~/slouch-app
npm install
```

## 3. Move to production location

```bash
sudo mkdir -p /var/www/slouch
sudo cp -r ~/slouch-app/* /var/www/slouch/
sudo chown -R ghostuser:ghostuser /var/www/slouch
```

## 4. Configure the admin password

Edit the systemd service file and change `CHANGE_THIS_PASSWORD`:

```bash
sudo nano /etc/systemd/system/slouch.service
```

## 5. Set up the systemd service

```bash
sudo cp /var/www/slouch/slouch.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable slouch
sudo systemctl start slouch
```

Verify it's running:
```bash
sudo systemctl status slouch
curl http://localhost:3001
```

## 6. Point DNS

Add an A record for `slou.ch` pointing to `144.126.236.254`
(wherever you manage the slou.ch domain's DNS)

## 7. Set up Nginx

```bash
sudo cp /var/www/slouch/nginx-slouch.conf /etc/nginx/sites-available/slouch
sudo ln -s /etc/nginx/sites-available/slouch /etc/nginx/sites-enabled/
```

Before enabling HTTPS, temporarily edit the config to only listen on port 80
without the SSL redirect, then get the certificate:

```bash
sudo certbot certonly --nginx -d slou.ch
```

Then restore the full config with SSL and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 8. Test

Visit https://slou.ch/admin — you should see the admin dashboard.

## Usage

- **Shorten URLs**: Enter a URL, optional title and custom code, click Shorten
- **Upload files**: Drag & drop or browse, optional custom code, click Upload
- **Access**: slou.ch/CODE redirects to URLs or serves files
- **Admin**: slou.ch/admin (password protected via HTTP Basic Auth)
