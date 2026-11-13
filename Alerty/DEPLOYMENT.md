# Развёртывание Alerty в домашней лабе

## Схема

- Разместить Alerty, Prometheus и Loki через Compose на Ubuntu 101. Предполагается, что это обычная Ubuntu-машина или VM, а не сам Proxmox VE host.
- В Prometheus добавить каждый узел в `monitoring/targets/nodes.json`. Ubuntu 101 уже включён как первый target через отдельный Node Exporter контейнер. Остальные Linux-узлы отдают метрики через Node Exporter на TCP 9100; Windows — через windows_exporter на TCP 9182.
- На Ubuntu 101 Compose запускает Alloy и отправляет systemd journal в локальный Loki. На остальных узлах установить Grafana Alloy: он отправляет системные журналы (Linux) или Windows Event Log (Windows) через TLS Nginx с Basic Auth.
- Доступ к панели с iPhone — через WireGuard. Внешние порты Prometheus/Loki не публикуются; Compose привязывает их HTTP-порты к loopback VM.

Образы зафиксированы на Prometheus 3.13.3, Loki 3.7.0, Node Exporter 1.12.1, windows_exporter 0.32.1 и Alloy 1.21.3. Для Linux Prometheus использует Node Exporter, для Windows — windows_exporter; Alloy собирает журналы, а не системные метрики. Текущие платформы и порты exporters сверять с [руководством Node Exporter](https://prometheus.io/docs/guides/node-exporter/) и [релизами windows_exporter](https://github.com/prometheus-community/windows_exporter/releases).

Начать можно с 2 vCPU, 4 GB RAM и 40 GB свободного места на Ubuntu 101. Это стартовая оценка для нескольких узлов, а не гарантия: объём хранилища Loki зависит от частоты и размера логов. Loki настроен хранить 14 дней, Prometheus — 30 дней.

## Запуск стека

1. Убедиться, что Ubuntu 101 — отдельная Ubuntu-машина/VM, и назначить ей постоянный адрес в домашней сети. Если под Ubuntu 101 имеется в виду сам Proxmox VE host, остановиться и разместить стек в Ubuntu VM.
2. Проверить Docker Engine и Compose plugin командами `docker --version` и `docker compose version`. Если их нет, установить по [официальной инструкции Docker для Ubuntu](https://docs.docker.com/engine/install/ubuntu/).
3. На Ubuntu 101 получить репозиторий и перейти в папку проекта:

   ```sh
   git clone https://github.com/fuzeotb-git/Codex.git
   cd Codex/Alerty
   ```

4. Создать локальный файл настроек и запустить стек:

   ```sh
   cp .env.example .env
   docker compose up -d --build
   ```

5. Проверить состояние командой `docker compose ps`. Локальные адреса на самой Ubuntu 101: Alerty `http://127.0.0.1:8080`, Prometheus `http://127.0.0.1:9090`, Loki `http://127.0.0.1:3100/ready`.

На старте можно открыть Alerty с Ubuntu 101 или через SSH-туннель. Доступ с iPhone появится после настройки WireGuard и безопасного проксирования панели; сервисные порты Prometheus/Loki наружу не публиковать.

Prometheus и Loki доступны с самой VM только через loopback. В Docker-сети Alerty обращается к ним по именам `prometheus` и `loki`. Loki не содержит встроенной авторизации; для отправки журналов удалённые Alloy-агенты идут через TLS Nginx и Basic Auth. Защита Loki reverse proxy обязательна; не пробрасывать порт 3100 напрямую в интернет.

Для Nginx добавлен пример `deploy/nginx-alerty-location.conf`. Добавить отдельного пользователя/пароль Nginx для агентов, включить TLS в существующем server block и направить `/loki/` на локальный порт 3100, а `/` — на Alerty. Задать тот же URL push endpoint и учётные данные в локальной конфигурации Alloy каждого узла.

## Подключение серверов

`monitoring/targets/nodes.json` уже содержит Ubuntu 101 как `host=ubuntu-101`; его exporter доступен только внутри Compose-сети. Пример для остальных узлов — `monitoring/targets/nodes.example.json.example`: добавить его targets в `nodes.json` и заменить адреса/метки на свои. Prometheus перечитывает список targets каждые 30 секунд. На удалённых серверах разрешить TCP 9100/9182 только с IP monitoring VM.

Node Exporter в Compose читает `/proc`, `/sys` и корневую файловую систему Ubuntu 101 только для чтения и работает без Linux capabilities. Из-за сетевой изоляции контейнера его сетевые показатели относятся к namespace контейнера; для сетевой статистики host-интерфейсов понадобится отдельная настройка host network или нативная служба.

Linux:

- на каждом другом Linux-хосте установить Node Exporter как службу;
- разрешить TCP 9100 от IP monitoring VM только в домашней сети/WireGuard;
- установить Alloy, добавить пользователя `alloy` в `adm` и `systemd-journal`, заполнить `LOKI_PUSH_URL`, `LOKI_USERNAME`, `LOKI_PASSWORD` и `ALERTY_NODE_NAME` по образцу `monitoring/alloy-linux.example.alloy`.

На Ubuntu 101 Alloy уже запускается Compose-контейнером; его конфигурация задаёт метки `host=ubuntu-101` и `job=systemd-journal`. На остальных Linux-хостах Alloy ставится нативно.

Требование к группам journald следует из [справки Alloy](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.journal/).

Windows:

- установить windows_exporter, оставить его endpoint доступным только с IP monitoring VM по TCP 9182;
- установить Grafana Alloy для Windows и настроить Event Log collection по `monitoring/alloy-windows.example.alloy`.

Компонент чтения Windows Event Log описан в [документации Alloy](https://grafana.com/docs/grafana-cloud/send-data/alloy/reference/components/loki/loki.source.windowsevent/).

## WireGuard

Перед настройкой определить, есть ли у домашнего подключения публичный IPv4/IPv6 или провайдер использует CGNAT, а также поддерживает ли роутер WireGuard или перенаправление UDP-порта. Если домашний узел доступен снаружи, WireGuard endpoint можно разместить на роутере либо на отдельной VM с перенаправлением одного UDP-порта. Если входящего маршрута нет из-за CGNAT, потребуется публичная точка WireGuard вне дома или другой инициируемый из дома VPN-маршрут. Для peer за NAT `PersistentKeepalive` может поддерживать mapping, но включать его следует только при необходимости ([WireGuard Quick Start](https://www.wireguard.com/quickstart/)). Конфигурации и приватные ключи создаются непосредственно на устройствах; приватные ключи не пересылать.

После получения сетевой схемы добавить iPhone как отдельный peer с доступом только к адресу VM/домену Alerty. WireGuard поддерживает peer keys, endpoint и `PersistentKeepalive` для узлов за NAT; keepalive включается только когда это нужно для поддержания NAT mapping.

## Что прислать для следующего шага

Никакие пароли, токены или приватные ключи не нужны. Достаточно ответить:

1. Proxmox host входит в эти три сервера или это три VM/машины поверх него?
2. ОС каждой из трёх машин (Linux/Windows, дистрибутив/версия) и нужно ли мониторить сам Proxmox host.
3. Подсеть домашней сети, например `192.168.1.0/24`, и свободен ли статический IP для monitoring VM. Внутренние IP можно временно обозначить `узел-1`, `узел-2`, `узел-3`.
4. Модель роутера и поддерживает ли он WireGuard; в кабинете провайдера/на WAN-странице адрес WAN — публичный или серый. Сам IP присылать необязательно.
5. Есть ли отдельный диск или SSD для метрик и логов и сколько дней логов хотите хранить.
