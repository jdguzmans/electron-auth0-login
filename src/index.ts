import codependency from 'codependency';
import * as electron from 'electron';
import qs from 'qs';
import request from 'request-promise-native';
import url from 'url';

const requirePeer = codependency.register(module);
const keytar = requirePeer('keytar', {optional: true});

import { getPKCEChallengePair, PKCEPair } from './cryptoUtils';

export interface Config {
    applicationName?: string,
    auth0Audience: string, // API we're going to access
    auth0ClientId: string,
    auth0Domain: string,
    auth0Scopes: string, // What permissions do we want?
    useRefreshTokens?: boolean,
    windowConfig?: object,
    auth0Params?: object
}

interface Auth0TokenResponse {
    access_token: string,
    expires_in: number
    scope: string,
    refresh_token?: string
    token_type: string
}

interface TokenProperties extends Auth0TokenResponse {
    created_time: number
}

export default class ElectronAuth0Login {
    private config: Config;
    private tokenProperties: TokenProperties | null;
    private useRefreshToken: boolean;
    private windowConfig = {
        width: 800,
        height: 600,
        alwaysOnTop: true,
        title: 'Log in',
        backgroundColor: '#202020'
    };

    constructor(config: Config) {
        this.config = config;
        this.tokenProperties = null;
        this.useRefreshToken = !!(config.useRefreshTokens && config.applicationName && keytar);

        if (config.windowConfig) {
            this.windowConfig = {
                ...this.windowConfig,
                ...config.windowConfig
            }
        }

        if (config.useRefreshTokens && !config.applicationName) {
            console.warn('electron-auth0-login: cannot use refresh tokens without an application name');
        }

        if (config.useRefreshTokens && !keytar) {
            console.warn('electron-auth0-login: cannot use refresh tokens without keytar installed');
        }
    }

    public async logout() {
        this.tokenProperties = null;
        if (this.useRefreshToken) {
            await keytar.deletePassword(this.config.applicationName, 'refresh-token');
        }
    }

    public async getToken(): Promise<string> {
        if (this.tokenProperties && timeToTokenExpiry(this.tokenProperties) > 60) {
            // We have a valid token - use it
            return this.tokenProperties.access_token;
        }
        if (this.useRefreshToken) {
            // See if we can use a refresh token
            const refreshToken = await keytar.getPassword(this.config.applicationName, 'refresh-token');
            if (!refreshToken) return this.login()
                try {
                    this.tokenProperties = await this.sendRefreshToken(refreshToken);
                    if (this.tokenProperties.refresh_token) {
                        keytar.setPassword(this.config.applicationName, 'refresh-token', this.tokenProperties.refresh_token);    
                    }
                    return this.tokenProperties.access_token;

                } catch (err) {
                    console.warn(
                        'electron-auth0-login: could not use refresh token, may have been revoked',
                        err,
                    )
                    if (err.name === 'RequestError') throw err
                    keytar.deletePassword(this.config.applicationName, 'refresh-token');
                    return this.login();
                }

        }

        return this.login();
    }

    private async sendRefreshToken(refreshToken: string): Promise<TokenProperties> {
        return request(`https://${this.config.auth0Domain}/oauth/token`, {
            method: 'POST',
            json: true,
            body: {
                grant_type: 'refresh_token',
                client_id: this.config.auth0ClientId,
                refresh_token: refreshToken
            }
        }).promise().then(toTokenMeta);
    }

    private async login() {
        const pkcePair = getPKCEChallengePair();
        const authCode = await this.getAuthCode(pkcePair);

        this.tokenProperties = await this.exchangeAuthCodeForToken(authCode, pkcePair);

        if (this.useRefreshToken && this.tokenProperties.refresh_token) {
            keytar.setPassword(this.config.applicationName, 'refresh-token', this.tokenProperties.refresh_token);
        }

        return this.tokenProperties.access_token;
    }

    private async getAuthCode(pkcePair: PKCEPair): Promise<string> {       
        return new Promise<string>((resolve, reject) => {
            const authCodeUrl = `https://${this.config.auth0Domain}/authorize?` + qs.stringify({
                audience: this.config.auth0Audience,                
                scope: this.config.auth0Scopes,
                response_type: 'code',
                client_id: this.config.auth0ClientId,
                code_challenge: pkcePair.challenge,
                code_challenge_method: 'S256',
                redirect_uri: `https://${this.config.auth0Domain}/mobile`,
                ...this.config.auth0Params
            });

            const authWindow = new electron.BrowserWindow(this.windowConfig);
    
            authWindow.webContents.on('did-navigate' as any, (event: any, href: string) => {
                const location = url.parse(href);
                if (location.pathname == '/mobile') {
                    const query = qs.parse(location.search || '', {ignoreQueryPrefix: true});
                    resolve(query.code);
                    authWindow.destroy();
                }
            });
    
            authWindow.on('close', reject);
    
            authWindow.loadURL(authCodeUrl);
        });
    }

    private async exchangeAuthCodeForToken(authCode: string, pkcePair: PKCEPair): Promise<TokenProperties> {
        return request(`https://${this.config.auth0Domain}/oauth/token`, {
            method: 'POST',
            json: true,
            body: {
                grant_type: 'authorization_code',
                client_id: this.config.auth0ClientId,
                code_verifier: pkcePair.verifier,
                code: authCode,
                redirect_uri: `https://${this.config.auth0Domain}/mobile`
            }
        }).promise().then(toTokenMeta);
    }
}

function timeToTokenExpiry(tokenMeta: TokenProperties): number {
    return tokenMeta.created_time + tokenMeta.expires_in - getEpochSeconds();
}

function toTokenMeta(tokenResponse: Auth0TokenResponse): TokenProperties {
    return {
        ...tokenResponse,
        created_time: getEpochSeconds()
    };
}

function getEpochSeconds() {
    return Date.now() / 1000;
}
