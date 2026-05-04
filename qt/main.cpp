/**
 * TimeHuddle Qt Desktop – "Login with TimeHuddle" (OAuth 2.0 + PKCE)
 *
 * Build requirements:
 *   Qt 6.x with QtNetwork, QtWebEngineWidgets (or QDesktopServices for URI scheme)
 *   CMake 3.20+
 *
 * CMakeLists.txt:
 *   find_package(Qt6 REQUIRED COMPONENTS Core Network Widgets)
 *   target_link_libraries(your_target Qt6::Core Qt6::Network Qt6::Widgets)
 *
 * Flow:
 *   1. Generate PKCE code_verifier (32 random bytes → base64url)
 *   2. code_challenge = BASE64URL(SHA256(code_verifier))
 *   3. Open system browser → /api/auth/oauth2/authorize
 *   4. Start local HTTP server on 127.0.0.1:PORT to catch the redirect
 *   5. Exchange auth code for tokens via /api/auth/oauth2/token
 *   6. Fetch user info via /api/auth/oauth2/userinfo
 */

#include <QApplication>
#include <QCryptographicHash>
#include <QDesktopServices>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLabel>
#include <QMainWindow>
#include <QMessageBox>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRandomGenerator>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTimer>
#include <QUrl>
#include <QUrlQuery>
#include <QVBoxLayout>
#include <QWidget>

// ─── Config ──────────────────────────────────────────────────────────────────

static const QString TIMEHUDDLE_BASE_URL = QStringLiteral("http://localhost:4000");
static const QString CLIENT_ID           = QStringLiteral("qt-timehuddle-desktop");
// Loopback redirect — no URI scheme registration needed
static const QString REDIRECT_HOST       = QStringLiteral("127.0.0.1");
static const int     REDIRECT_PORT       = 19876; // arbitrary free port

// ─── PKCE helpers ────────────────────────────────────────────────────────────

/** Generate a cryptographically-random base64url string (no padding). */
static QString randomBase64Url(int byteCount)
{
    QByteArray bytes(byteCount, Qt::Uninitialized);
    for (int i = 0; i < byteCount; ++i)
        bytes[i] = static_cast<char>(QRandomGenerator::secureInstance()->generate() & 0xFF);
    return bytes.toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals);
}

/** SHA-256 of input, returned as base64url (no padding). */
static QString sha256Base64Url(const QString &input)
{
    QByteArray hash = QCryptographicHash::hash(input.toUtf8(), QCryptographicHash::Sha256);
    return hash.toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals);
}

// ─── Loopback redirect server ────────────────────────────────────────────────

/**
 * Minimal TCP server that listens on 127.0.0.1:PORT for the OAuth redirect.
 * better-auth sends:  GET /?code=AUTH_CODE&state=STATE HTTP/1.1
 * We parse the code, send an HTML response, then emit codeReceived().
 */
class LoopbackServer : public QObject
{
    Q_OBJECT
public:
    explicit LoopbackServer(QObject *parent = nullptr) : QObject(parent) {}

    bool listen()
    {
        m_server = new QTcpServer(this);
        if (!m_server->listen(QHostAddress::LocalHost, REDIRECT_PORT)) {
            return false;
        }
        connect(m_server, &QTcpServer::newConnection, this, &LoopbackServer::onNewConnection);
        return true;
    }

signals:
    void codeReceived(const QString &code, const QString &state);
    void errorOccurred(const QString &message);

private slots:
    void onNewConnection()
    {
        QTcpSocket *socket = m_server->nextPendingConnection();
        connect(socket, &QTcpSocket::readyRead, this, [this, socket]() {
            const QByteArray data = socket->readAll();
            // Parse first line: "GET /callback?code=...&state=... HTTP/1.1"
            const QString firstLine = QString::fromUtf8(data).split('\n').first().trimmed();
            const QStringList parts  = firstLine.split(' ');
            if (parts.size() < 2) {
                socket->close();
                return;
            }

            QUrl requestUrl(QStringLiteral("http://localhost") + parts[1]);
            QUrlQuery query(requestUrl.query());
            const QString code  = query.queryItemValue(QStringLiteral("code"));
            const QString state = query.queryItemValue(QStringLiteral("state"));
            const QString error = query.queryItemValue(QStringLiteral("error"));

            // Respond with a friendly page so the browser tab can be closed
            const QByteArray html =
                "<html><body style='font-family:sans-serif;text-align:center;padding:3em'>"
                "<h2>✅ Authorization complete</h2>"
                "<p>You can close this tab and return to TimeHuddle Desktop.</p>"
                "</body></html>";
            const QByteArray response =
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: text/html\r\n"
                "Connection: close\r\n\r\n" + html;
            socket->write(response);
            socket->flush();
            socket->disconnectFromHost();

            m_server->close(); // accept no more connections

            if (!error.isEmpty()) {
                emit errorOccurred(QStringLiteral("OAuth error: ") + error);
            } else if (!code.isEmpty()) {
                emit codeReceived(code, state);
            } else {
                emit errorOccurred(QStringLiteral("No auth code in redirect"));
            }
        });
    }

private:
    QTcpServer *m_server = nullptr;
};

// ─── OAuth client ────────────────────────────────────────────────────────────

class TimeHuddleAuth : public QObject
{
    Q_OBJECT
public:
    explicit TimeHuddleAuth(QObject *parent = nullptr)
        : QObject(parent), m_nam(new QNetworkAccessManager(this)) {}

    void startLogin()
    {
        // 1. Generate PKCE pair
        m_codeVerifier  = randomBase64Url(32);
        m_codeChallenge = sha256Base64Url(m_codeVerifier);
        m_state         = randomBase64Url(16);

        // 2. Start loopback server
        m_server = new LoopbackServer(this);
        connect(m_server, &LoopbackServer::codeReceived,    this, &TimeHuddleAuth::onCodeReceived);
        connect(m_server, &LoopbackServer::errorOccurred,   this, &TimeHuddleAuth::loginFailed);
        if (!m_server->listen()) {
            emit loginFailed(QStringLiteral("Could not start local redirect server on port %1")
                                 .arg(REDIRECT_PORT));
            return;
        }

        // 3. Build authorization URL
        const QString redirectUri =
            QStringLiteral("http://%1:%2").arg(REDIRECT_HOST).arg(REDIRECT_PORT);

        QUrl url(TIMEHUDDLE_BASE_URL + QStringLiteral("/api/auth/oauth2/authorize"));
        QUrlQuery q;
        q.addQueryItem(QStringLiteral("response_type"),         QStringLiteral("code"));
        q.addQueryItem(QStringLiteral("client_id"),             CLIENT_ID);
        q.addQueryItem(QStringLiteral("redirect_uri"),          redirectUri);
        q.addQueryItem(QStringLiteral("scope"),                 QStringLiteral("openid profile email"));
        q.addQueryItem(QStringLiteral("state"),                 m_state);
        q.addQueryItem(QStringLiteral("code_challenge"),        m_codeChallenge);
        q.addQueryItem(QStringLiteral("code_challenge_method"), QStringLiteral("S256"));
        url.setQuery(q);

        // 4. Open the system browser — user logs in and consents in the browser
        QDesktopServices::openUrl(url);
    }

signals:
    void loginSucceeded(const QString &name, const QString &email);
    void loginFailed(const QString &reason);

private slots:
    void onCodeReceived(const QString &code, const QString &state)
    {
        if (state != m_state) {
            emit loginFailed(QStringLiteral("State mismatch — possible CSRF"));
            return;
        }

        // 5. Exchange code for tokens
        const QString redirectUri =
            QStringLiteral("http://%1:%2").arg(REDIRECT_HOST).arg(REDIRECT_PORT);

        QNetworkRequest req(QUrl(TIMEHUDDLE_BASE_URL + QStringLiteral("/api/auth/oauth2/token")));
        req.setHeader(QNetworkRequest::ContentTypeHeader,
                      QStringLiteral("application/x-www-form-urlencoded"));

        QUrlQuery body;
        body.addQueryItem(QStringLiteral("grant_type"),    QStringLiteral("authorization_code"));
        body.addQueryItem(QStringLiteral("code"),          code);
        body.addQueryItem(QStringLiteral("redirect_uri"),  redirectUri);
        body.addQueryItem(QStringLiteral("client_id"),     CLIENT_ID);
        body.addQueryItem(QStringLiteral("code_verifier"), m_codeVerifier);

        auto *reply = m_nam->post(req, body.toString(QUrl::FullyEncoded).toUtf8());
        connect(reply, &QNetworkReply::finished, this, [this, reply]() {
            reply->deleteLater();
            if (reply->error() != QNetworkReply::NoError) {
                emit loginFailed(reply->errorString());
                return;
            }

            const QJsonObject json =
                QJsonDocument::fromJson(reply->readAll()).object();

            m_accessToken  = json[QStringLiteral("access_token")].toString();
            m_refreshToken = json[QStringLiteral("refresh_token")].toString();

            if (m_accessToken.isEmpty()) {
                emit loginFailed(QStringLiteral("Token exchange failed — no access_token"));
                return;
            }

            fetchUserInfo();
        });
    }

    void fetchUserInfo()
    {
        // 6. GET /api/auth/oauth2/userinfo with Bearer token
        QNetworkRequest req(
            QUrl(TIMEHUDDLE_BASE_URL + QStringLiteral("/api/auth/oauth2/userinfo")));
        req.setRawHeader(QByteArrayLiteral("Authorization"),
                         QStringLiteral("Bearer %1").arg(m_accessToken).toUtf8());

        auto *reply = m_nam->get(req);
        connect(reply, &QNetworkReply::finished, this, [this, reply]() {
            reply->deleteLater();
            if (reply->error() != QNetworkReply::NoError) {
                emit loginFailed(reply->errorString());
                return;
            }

            const QJsonObject user =
                QJsonDocument::fromJson(reply->readAll()).object();

            const QString name  = user[QStringLiteral("name")].toString();
            const QString email = user[QStringLiteral("email")].toString();
            emit loginSucceeded(name, email);
        });
    }

private:
    QNetworkAccessManager *m_nam    = nullptr;
    LoopbackServer        *m_server = nullptr;
    QString m_codeVerifier;
    QString m_codeChallenge;
    QString m_state;
    QString m_accessToken;
    QString m_refreshToken;
};

// ─── Main window ─────────────────────────────────────────────────────────────

class MainWindow : public QMainWindow
{
    Q_OBJECT
public:
    explicit MainWindow(QWidget *parent = nullptr) : QMainWindow(parent)
    {
        setWindowTitle(QStringLiteral("TimeHuddle Desktop"));
        resize(400, 200);

        auto *central = new QWidget(this);
        auto *layout  = new QVBoxLayout(central);

        m_statusLabel = new QLabel(QStringLiteral("Not signed in"), central);
        m_statusLabel->setAlignment(Qt::AlignCenter);
        layout->addWidget(m_statusLabel);

        auto *loginBtn = new QPushButton(QStringLiteral("Login with TimeHuddle"), central);
        layout->addWidget(loginBtn);

        setCentralWidget(central);

        m_auth = new TimeHuddleAuth(this);
        connect(loginBtn, &QPushButton::clicked, m_auth, &TimeHuddleAuth::startLogin);

        connect(m_auth, &TimeHuddleAuth::loginSucceeded, this,
                [this](const QString &name, const QString &email) {
                    m_statusLabel->setText(
                        QStringLiteral("Signed in as %1 (%2)").arg(name, email));
                });

        connect(m_auth, &TimeHuddleAuth::loginFailed, this,
                [this](const QString &reason) {
                    QMessageBox::critical(this, QStringLiteral("Login failed"), reason);
                });
    }

private:
    QLabel        *m_statusLabel = nullptr;
    TimeHuddleAuth *m_auth       = nullptr;
};

// ─── Entry ───────────────────────────────────────────────────────────────────

#include "main.moc"

int main(int argc, char *argv[])
{
    QApplication app(argc, argv);
    app.setApplicationName(QStringLiteral("TimeHuddle Desktop"));
    app.setOrganizationName(QStringLiteral("MIEWeb"));

    MainWindow w;
    w.show();
    return app.exec();
}
